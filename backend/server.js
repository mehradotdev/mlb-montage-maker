import express from 'express';
import multer from 'multer';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { VertexAI } from '@google-cloud/vertexai';

// --------------------------
// Configuration & Constants
// --------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FRAME_RATE = 30;
const FRAME_DURATION = 1 / FRAME_RATE;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_BUCKET_ID = process.env.GCP_BUCKET_ID;
const GCP_REGION = 'us-central1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'assets', 'system-prompt.txt'), 'utf8');
const POSTHOG_API_HOST = 'https://eu.i.posthog.com';
const POSTHOG_ASSETS_HOST = 'https://eu-assets.i.posthog.com';

const app = express();
app.set('case sensitive routing', false); // disable case-sensitive routing
const geminiResponseCache = new Map();
const modelGenerationConfig = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
};

// Initialize Vertex AI client
const vertexAI = new VertexAI({ project: GCP_PROJECT_ID, location: GCP_REGION });
const generativeModel = vertexAI.getGenerativeModel({
  model: 'gemini-2.0-flash-exp',
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: modelGenerationConfig,
});

if (!GCP_PROJECT_ID || !GCP_BUCKET_ID) {
  console.error("Error: GCP_PROJECT_ID or GCP_BUCKET_ID environment variables are not set.");
  process.exit(1); // Exit if essential GCP variables are missing
}

// Directory configuration
const directories = {
  uploads: path.join(__dirname, 'uploads'),
  outputVideos: path.join(__dirname, 'downloads'),
  assets: path.join(__dirname, 'assets'),
};

// Create required directories if they don't exist
Object.entries(directories).forEach(([name, dirPath]) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`Created directory: ${name} -> ${dirPath}`);
  }
});

// Configure FFmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// --------------------------
// Middleware Configuration
// --------------------------
const whitelist = [
  // 'http://localhost:5173',
  // 'http://localhost:4173',
  // 'https://mlb-montage-maker.pages.dev',
  'https://mlb-montage-maker.mehra.dev',
];
const corsOptions = {
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept'],
  methods: ['GET', 'POST', 'OPTIONS'],
  origin: whitelist,
  // origin: function (origin, callback) {
  //   if (whitelist.indexOf(origin) !== -1 || !origin) {
  //     callback(null, true)
  //   } else {
  //     callback(new Error('Not allowed by CORS'))
  //   }
  // }
}
// app.use(cors(corsOptions));
app.use(cors());
const upload = multer({
  storage: multer.diskStorage({
    destination: directories.uploads,
    filename: (req, file, cb) => {
      const uniqueName = `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    }
  }),
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('audio/') ? cb(null, true) : cb(null, false),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// --------------------------
// In-Memory Run Tracking
// --------------------------
const currentRunsObj = {};

// --------------------------
// Helper Functions
// --------------------------

/**
 * Validates the montage creation request.
 * @param {Request} req - Express request object.
 * @returns {object|null} - Validated montage data or null if invalid.
 */
function validateMontageRequest(req) {
  const montageData = JSON.parse(req.body.montageData);
  if (!montageData || !montageData.gamePk || !montageData.reelRegion || !montageData.beatMarkers) {
    return null; // Indicate invalid data
  }
  return montageData; // Return validated data
}

/**
 * Calls the Gemini API to analyze the video.
 * @param {string} videoUrl - GCS URL of the video.
 * @param {number} videoDuration - Duration of the video in seconds.
 * @returns {Promise<string>} - Gemini API response text.
 */
async function callGeminiAPI(videoUrl, videoDuration) {
  console.log(`Calling Gemini API for video from GCS URL: ${videoUrl}, Duration: ${videoDuration} seconds`);

  if (geminiResponseCache.has(videoUrl)) {
    console.log("Cache hit! Returning cached Gemini API response.");
    return geminiResponseCache.get(videoUrl); // Return cached response
  }

  try {
    const request = {
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: videoUrl, mimeType: 'video/mp4' } },
          {
            text: `Analyze this baseball game video and identify key moments.
            Provide the start and end timestamps of each key moment in seconds (integer format).
            Ensure all timestamps are within the video's duration, which is ${videoDuration} seconds.
            Include a brief description and reason for each key moment. Output the results as a JSON array.`
          },
        ],
      }],
    };

    const geminiResponse = await generativeModel.generateContent(request);
    const responseText = geminiResponse.response.candidates[0].content.parts[0].text;

    geminiResponseCache.set(videoUrl, responseText);
    console.log("Storing Gemini API response in cache.", responseText);

    // Set cache expiration (1 hour)
    const cacheTTL_ms = 60 * 60 * 1000;
    setTimeout(() => {
      geminiResponseCache.delete(videoUrl);
      console.log(`Cache entry for key '${videoUrl}' expired and deleted.`);
    }, cacheTTL_ms);

    return responseText;
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw error;
  }
}

/**
 * Uses ffmpeg.ffprobe to calculate the duration of the source video.
 * @param {string} sourcePath - Path to the source video.
 * @returns {Promise<number>} Duration of the video in seconds.
 */
function getVideoDuration(sourcePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(sourcePath, (err, metadata) => {
      if (err) return reject(err);
      if (!metadata || !metadata.format || !metadata.format.duration) {
        return reject(new Error("Could not determine video duration"));
      }
      resolve(metadata.format.duration);
    });
  });
}

/**
 * Aligns time to nearest frame boundary.
 * @param {number} seconds - Input time in seconds.
 * @returns {number} Frame-aligned time in seconds.
 */
const alignToFrames = (seconds) => {
  return Math.round(seconds / FRAME_DURATION) * FRAME_DURATION;
};

/**
 * Calculates beat intervals from beat markers and reel region.
 * @param {number[]} beatMarkers - Array of beat timestamps.
 * @param {object} reelRegion - Reel region object {start, end}.
 * @returns {number[]} - Array of beat intervals.
 */
function calculateBeatIntervals(beatMarkers, reelRegion) {
  const alignedStart = alignToFrames(reelRegion.start);
  const alignedEnd = alignToFrames(reelRegion.end);
  const validBeats = beatMarkers
    .filter(beat => beat >= alignedStart && beat <= alignedEnd)
    .sort((a, b) => a - b);

  const intervals = [];
  let previousBeat = alignedStart;
  for (const beat of validBeats) {
    intervals.push(beat - previousBeat);
    previousBeat = beat;
  }
  if (previousBeat < alignedEnd) {
    intervals.push(alignedEnd - previousBeat);
  }
  return intervals;
}

/**
 * Processes and validates the clips data from Gemini API.
 * If the JSON is invalid or not an array, returns a fallback clip covering the entire source video.
 * If valid, filters out clip objects with invalid timestamps.
 *
 * @param {string} geminiResponseData - JSON string from Gemini API.
 * @param {number} sourceDuration - Duration of the source video in seconds.
 * @returns {object[]} Array of validated clip objects.
 */
function processAndValidateClips(geminiResponseData, sourceDuration) {
  let clipsArray;
  try {
    clipsArray = JSON.parse(geminiResponseData);
    if (!Array.isArray(clipsArray)) {
      throw new Error("Parsed data is not an array");
    }
  } catch (e) {
    console.warn("Invalid Gemini response JSON. Falling back to a default clip. Error:", e.message);
    return [{
      start_timestamp: 0,
      end_timestamp: sourceDuration,
      description: "Fallback clip covering the entire source video."
    }];
  }

  const validClips = clipsArray.filter((clip) => {
    if (!clip.start_timestamp || !clip.end_timestamp) {
      console.warn("Clip missing timestamps:", clip);
      return false;
    }
    const startSec = Number(clip.start_timestamp);
    const endSec = Number(clip.end_timestamp);

    if (isNaN(startSec) || isNaN(endSec)) {
      console.warn("Clip has invalid timestamp format (not a number):", clip);
      return false;
    }
    if (startSec < 0 || endSec < 0 || startSec >= endSec) {
      console.warn("Clip has non-sensical timestamps:", clip);
      return false;
    }
    // Ensure clip is within source video bounds.
    if (startSec < 0 || endSec > sourceDuration) {
      console.warn("Clip timestamps are out of source video bounds:", clip);
      return false;
    }
    return true;
  });

  if (validClips.length === 0) {
    console.warn("No valid clips found after filtering. Using fallback clip.");
    return [{
      start_timestamp: 0,
      end_timestamp: sourceDuration,
      description: "Fallback clip covering the entire video."
    }];
  }

  return validClips;
}

/**
 * Updates the run status in the currentRunsObj.
 * @param {string} runId - Unique run ID.
 * @param {string} status - Montage generation status ('processing', 'completed', 'failed').
 * @param {number} progress - Progress percentage (0-100).
 * @param {string} progressMessage - Progress message to display.
 * @param {string|null} finishedMontagePath - FILE PATH of the finished montage, or null if not yet available.
 */
function updateRunStatus(runId, status, progress, progressMessage, finishedMontagePath = null) {
  if (currentRunsObj[runId]) {
    currentRunsObj[runId].status = status;
    currentRunsObj[runId].progress = progress;
    currentRunsObj[runId].progressMessage = progressMessage;
    currentRunsObj[runId].finishedMontagePath = finishedMontagePath;
  }
}

/**
 * Cleans up resources after montage generation (deletes files, removes runId).
 * @param {string} runId - Unique run ID.
 * @param {string} outputPath - Path to the output video file.
 * @param {string|null} audioFilePath - Path to the uploaded audio file (if any).
 */
function cleanupRun(runId, outputPath, audioFilePath = null) {
  // Schedule runId and output video cleanup after 10 minutes
  setTimeout(() => {
    delete currentRunsObj[runId];
    console.log(`runId ${runId} removed from currentRunsObj after 10 minutes.`);

    fs.unlink(outputPath, (err) => {
      if (err) console.error('Video cleanup failed:', err.message);
      else console.log(`Deleted montage: ${outputPath}`);
    });

    // Cleanup uploaded audio if it exists
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
      console.log(`Deleted uploaded audio: ${audioFilePath}`);
    }
  }, 10 * 60 * 1000); // 10 minutes
}

/**
 * Empties the downloads directory at server startup.
 */
function emptyFoldersOnInitialLoad() {
  const folderPathList = [directories.outputVideos, directories.uploads];

  folderPathList.forEach((folder) => {
    if (fs.existsSync(folder)) {
      const files = fs.readdirSync(folder);
      for (const file of files) {
        const filePath = path.join(folder, file);
        try {
          fs.unlinkSync(filePath);
          console.log(`Deleted file from ${folder}: ${filePath}`);
        } catch (err) {
          console.error(`Error deleting file from ${folder}: ${filePath}`, err);
        }
      }
      console.log(`${folder} folder emptied on server start.`);
    } else {
      console.log(`${folder} folder does not exist, skipping cleanup.`);
    }
  });
}

// --------------------------
// Video Processing Functions
// --------------------------

/**
 * Creates final montage video with audio synchronization.
 * @param {string} sourcePath - Path to source video.
 * @param {string} audioPath - Path to audio track.
 * @param {number[]} intervals - Array of clip durations (in seconds).
 * @param {object[]} clipsData - Video clip metadata.
 * @param {string} outputPath - Output file path.
 * @param {number} alignedStart - Start time in seconds.
 * @param {number} alignedEnd - End time in seconds.
 */
async function createFinalMontage(
  sourcePath,
  audioPath,
  intervals,
  clipsData,
  outputPath,
  alignedStart,
  alignedEnd
) {
  // Calculate the duration for the montage (audio and video)
  const montageDuration = alignedEnd - alignedStart;
  // Fade will start 2 seconds before the end of the montage
  const fadeStart = Math.max(0, montageDuration - 2); // Start fade 2 seconds before end

  // ------------------------------------------------------
  // Process montage segments using clipsData & round-robin
  // ------------------------------------------------------
  // Build a working copy of clipsData with start and end times in seconds.
  const workingClips = clipsData.map(clip => {
    return {
      origStart: Number(clip.start_timestamp),
      currentStart: Number(clip.start_timestamp),
      end: Number(clip.end_timestamp)
    };
  });

  // This array will hold all the segment filter strings for FFmpeg.
  const montageClipFilters = [];
  let segmentCounter = 0; // used to number each segment filter (e.g., [mv0], [mv1], …)
  let clipIndex = 0; // used for round-robin selection of clips

  // Process each interval (each interval is the total time that must be filled)
  intervals.forEach((intervalDuration) => {
    let remainingInterval = intervalDuration;
    // Fill the current interval using one or more segments from the clips
    while (remainingInterval > 0) {
      // Select the next clip in round-robin order
      const currentClip = workingClips[clipIndex % workingClips.length];
      // Determine how much time is available in the current clip.
      let available = currentClip.end - currentClip.currentStart;

      // If the clip is exhausted, reset its currentStart back to its original start.
      if (available <= 0) {
        currentClip.currentStart = currentClip.origStart;
        available = currentClip.end - currentClip.currentStart;
      }

      // The segment duration is the smaller of the remaining interval or what’s available from the clip.
      const segmentDuration = Math.min(remainingInterval, available);

      // Build the FFmpeg trim filter for this segment.
      // Example: [0:v]trim=start=12:duration=1.5,setpts=PTS-STARTPTS[mv0];
      montageClipFilters.push(
        `[0:v]trim=start=${currentClip.currentStart}:duration=${segmentDuration},setpts=PTS-STARTPTS[mv${segmentCounter}];`
      );

      // Update the clip's current start time.
      currentClip.currentStart += segmentDuration;

      // Subtract the used duration from the interval.
      remainingInterval -= segmentDuration;

      // Increment counters for segment and clip round-robin.
      segmentCounter++;
      clipIndex++;
    }
  });

  // Build the concat filter string for all the montage segments.
  // For example, if there are 5 segments, we want: [mv0][mv1][mv2][mv3][mv4]concat=n=5:v=1:a=0[montage_v];
  const montageInputs = [];
  for (let i = 0; i < segmentCounter; i++) {
    montageInputs.push(`[mv${i}]`);
  }
  const montageConcatFilter = `${montageInputs.join('')}concat=n=${segmentCounter}:v=1:a=0[montage_v];`;

  // ------------------------------------------------------
  // Build and execute the FFmpeg command
  // ------------------------------------------------------
  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(sourcePath)
      .input(audioPath);

    // Build FFmpeg filter graph
    const filters = [
      // Add all montage segment filters.
      ...montageClipFilters,
      // Concatenate the segments into one video stream.
      montageConcatFilter,
      // Process the audio track: trim it to the montage duration.
      `[1:a]atrim=start=${alignedStart}:duration=${montageDuration},asetpts=PTS-STARTPTS[montage_a];`,
      // Add fade-out effects to both video and audio.
      `[montage_v]fade=t=out:st=${fadeStart}:d=2[faded_v];`,
      `[montage_a]afade=t=out:st=${fadeStart}:d=2[faded_a]`
    ];

    console.log("Final Montage render started!");

    command.complexFilter(filters.join(''))
      .outputOptions([
        '-map', '[faded_v]',  // Map faded video stream
        '-map', '[faded_a]',  // Map faded audio stream
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart'
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', (err) => {
        console.error('FFmpeg error on Final Montage creation:', err.message);
        reject(err);
      });
  });
}

// --------------------------
// API Endpoints
// --------------------------

app.post('/initMontageCreation', upload.single('audioFile'), async (req, res) => {
  let runId; // Declare runId outside the try block
  let outputPath; // Output path for the montage

  try {
    const montageData = validateMontageRequest(req);
    if (!montageData) {
      return res.status(400).json({ status: 'error', message: 'Invalid montage data provided.' });
    }

    const { gamePk, reelRegion, beatMarkers, musicName } = montageData;
    const audioPath = req.file?.path || path.join(directories.assets, 'music', musicName);
    const sourceVideoGCSUrl = `gs://${GCP_BUCKET_ID}/source_${gamePk}_480p.mp4`;
    const sourceVideo = path.join(directories.assets, 'videos', `source_${gamePk}_480p.mp4`);

    if (!fs.existsSync(audioPath)) throw new Error('Audio file not found');
    if (!fs.existsSync(sourceVideo)) throw new Error('Source video not found');

    runId = Date.now().toString(); // Generate unique runId
    outputPath = path.join(directories.outputVideos, `final_montage_${runId}.mp4`);

    // Initialize run status in memory
    currentRunsObj[runId] = {
      status: 'processing',
      progress: 0,
      progressMessage: 'Initializing montage creation...',
      montageData: montageData,
      audioPath: audioPath,
      sourceVideo: sourceVideo,
      sourceVideoGCSUrl: sourceVideoGCSUrl,
      finishedMontagePath: null,
      startTime: Date.now(),
    };

    console.log(`Montage creation started for runId: ${runId}`);
    res.json({ status: 'success', runId: runId }); // Respond immediately with runId

    // --- Start Asynchronous Montage Generation ---
    setTimeout(async () => {
      try {
        updateRunStatus(runId, 'processing', 10, 'Analyzing video...');
        const sourceDuration = await getVideoDuration(sourceVideo); // calculate the source video's duration.
        const geminiResponseData = await callGeminiAPI(sourceVideoGCSUrl, sourceDuration);
        updateRunStatus(runId, 'processing', 70, 'Rendering montage...');

        // --- VALIDATE RESPONSE ---
        // Instead of directly parsing geminiResponseData, we now call processAndValidateClips.
        // If geminiResponseData is not valid JSON or not an array, this function returns a fallback clip
        // covering the entire source video. If it is a valid JSON array, it will filter out any invalid clip objects.
        const clipsData = processAndValidateClips(geminiResponseData, sourceDuration);
        const intervals = calculateBeatIntervals(beatMarkers, reelRegion);

        await createFinalMontage(
          sourceVideo,
          audioPath,
          intervals,
          clipsData,
          outputPath,
          alignToFrames(reelRegion.start),
          alignToFrames(reelRegion.end)
        );

        updateRunStatus(runId, 'completed', 100, 'Montage creation completed!', outputPath); // Passing outputPath
        console.log(`Montage generation completed successfully for runId: ${runId}`);
      } catch (error) {
        console.error(`Error during background montage generation for runId ${runId}:`, error);
        updateRunStatus(runId, 'failed', 0, 'Montage generation failed. Please check server logs.');
      } finally {
        cleanupRun(runId, outputPath, req.file?.path); // Cleanup after completion or failure
      }
    }, 0); // 0ms delay for async execution

  } catch (error) {
    console.error('Error in /initMontageCreation:', error);
    updateRunStatus(runId, 'failed', 0, 'Montage creation request failed.'); // Update status for initial error
    res.status(500).json({ status: 'error', message: 'Montage creation failed.' });
    cleanupRun(runId, outputPath, req.file?.path); // Cleanup even on initial error
  }
});

app.get('/montageStatus', (req, res) => {
  const runId = req.query.runId;

  if (!runId) {
    return res.status(400).json({ status: 'error', message: 'Missing runId parameter.' });
  }

  const runData = currentRunsObj[runId];
  if (!runData) {
    return res.status(404).json({ status: 'error', message: 'RunId not found.' });
  }

  res.json({
    status: runData.status,
    progress: runData.progress,
    progressMessage: runData.progressMessage,
    finishedMontageUrl: `/getVideo?runId=${runId}`,
  });
});

app.get('/getVideo', (req, res) => {
  const runId = req.query.runId;

  if (!runId) {
    return res.status(400).send('Missing runId parameter.');
  }

  const runData = currentRunsObj[runId];
  if (!runData) {
    return res.status(404).send('RunId not found.');
  }

  const videoPath = runData.finishedMontagePath;
  if (!videoPath) {
    return res.status(404).send('Video file path not available for this runId.');
  }

  if (!videoPath.startsWith(directories.outputVideos)) {
    return res.status(400).send('Invalid videoPath.');
  }

  fs.access(videoPath, fs.constants.R_OK, (err) => {
    if (err) {
      return res.status(404).send('Video file not found on server.');
    }

    // Set Content-Disposition header to force download
    res.setHeader('Content-Disposition', `attachment; filename="baseball_montage_${runId}.mp4"`);
    res.sendFile(videoPath); // Send the video file
  });
});

app.get('/areYouAlive', (req, res) => {
  res.json({ message: "Yes!, alive and well! 😁" });
});

// Proxy middleware for /ingest and /decide endpoints
app.use('/ingest/static', createProxyMiddleware({
  target: `${POSTHOG_ASSETS_HOST}/static`,
  changeOrigin: true,
}));

app.use('/ingest/decide', createProxyMiddleware({
  target: `${POSTHOG_API_HOST}/decide`,
  changeOrigin: true,
}));

app.use('/ingest', createProxyMiddleware({
  target: `${POSTHOG_API_HOST}`,
  changeOrigin: true,
}));

// --------------------------
// Server Initialization
// --------------------------

// Empty downloads, uploads folder on server start
emptyFoldersOnInitialLoad();

app.listen(PORT, () => {
  console.log(`Montage server running on port ${PORT}`);
});
