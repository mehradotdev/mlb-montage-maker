import express from 'express';
import multer from 'multer';
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
const FRAME_RATE = 59.94;
const FRAME_DURATION = 1 / FRAME_RATE;
const GCP_PROJECT_ID = 'mlb-montage-maker';
const GCP_BUCKET_ID = 'mlb-montage-maker';
const GCP_REGION = 'us-central1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'assets', 'system-prompt.txt'), 'utf8');

const app = express();
app.set('case sensitive routing', false); // Add this line to disable case-sensitive routing
const geminiResponseCache = new Map();
const modelGenerationConfig = {
  temperature: 0,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
};

// Initialize Vertex AI client
const vertexAI = new VertexAI({ project: GCP_PROJECT_ID, location: GCP_REGION });
const generativeModel = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp', systemInstruction: SYSTEM_PROMPT, generationConfig: modelGenerationConfig });

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
app.use(cors());
const upload = multer({
  storage: multer.diskStorage({
    destination: directories.uploads,
    filename: (req, file, cb) => {
      const uniqueName = `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    }
  }),
  fileFilter: (req, file, cb) => file.mimetype.startsWith('audio/') ? cb(null, true) : cb(null, false),
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
 * @returns {Promise<string>} - Gemini API response text.
 */
async function callGeminiAPI(videoUrl) {
  console.log("Calling Gemini API for video from GCS URL:", videoUrl);

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
          { text: "Analyze this video and identify key moments with timestamps and descriptions." },
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
 * Converts timestamp string to total seconds.
 * @param {string} timestamp - Format: HH:MM:SS
 * @returns {number} Total seconds.
 */
const timeToSeconds = (timestamp) => {
  const [hours, minutes, seconds] = (timestamp || '00:00:00').split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

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
function emptyDownloadsFolder() {
  const downloadsPath = directories.outputVideos;
  if (fs.existsSync(downloadsPath)) {
    const files = fs.readdirSync(downloadsPath);
    for (const file of files) {
      const filePath = path.join(downloadsPath, file);
      try {
        fs.unlinkSync(filePath);
        console.log(`Deleted file from downloads: ${filePath}`);
      } catch (err) {
        console.error(`Error deleting file from downloads: ${filePath}`, err);
      }
    }
    console.log('Downloads folder emptied on server start.');
  } else {
    console.log('Downloads folder does not exist, skipping cleanup.');
  }
}


// --------------------------
// Video Processing Functions
// --------------------------

/**
 * Creates final montage video with audio synchronization
 * @param {string} sourcePath - Path to source video
 * @param {string} audioPath - Path to audio track
 * @param {number[]} intervals - Array of clip durations (in seconds)
 * @param {object[]} clipsData - Video clip metadata
 * @param {object} firstClip - First clip configuration
 * @param {object} lastClip - Last clip configuration
 * @param {string} outputPath - Output file path
 * @param {number} alignedStart - Start time in seconds
 * @param {number} alignedEnd - End time in seconds
 */
async function createFinalMontage(
  sourcePath,
  audioPath,
  intervals,
  clipsData,
  firstClip,
  lastClip,
  outputPath,
  alignedStart,
  alignedEnd
) {
  const montageDuration = alignedEnd - alignedStart;

  // Calculate clip durations for first and last clips
  // const firstClipDuration = timeToSeconds(firstClip.end_timestamp) - timeToSeconds(firstClip.start_timestamp); // temporary disable
  // const lastClipDuration = timeToSeconds(lastClip.end_timestamp) - timeToSeconds(lastClip.start_timestamp); // temporary disable
  const firstClipDuration = 0.1; // 1st clip duration
  const lastClipDuration = 0.05; // last clip duration
  const totalDuration = firstClipDuration + montageDuration + lastClipDuration;
  const fadeStart = Math.max(0, totalDuration - 2); // Start fade 2 seconds before end

  // ********************************************
  // New Montage Clips Processing Logic Start Here
  // ********************************************

  // Create a working copy of clipsData
  // Each working clip holds its original start time, current start time (both in seconds), and end time.
  const workingClips = clipsData.map(clip => {
    const origStart = timeToSeconds(clip.start_timestamp);
    return {
      origStart,
      currentStart: origStart,
      end: timeToSeconds(clip.end_timestamp)
    };
  });

  // This array will hold all the segment filter strings
  const montageClipFilters = [];
  let segmentCounter = 0; // used to name each segment filter ([mv0], [mv1], …)
  let clipIndex = 0; // used for round-robin selection of clips

  // Process each interval (each interval is the total time that must be filled)
  intervals.forEach((intervalDuration) => {
    let remainingInterval = intervalDuration;
    // Fill the current interval using one or more segments from the clips
    while (remainingInterval > 0) {
      // Select the next clip in round-robin order
      const currentClip = workingClips[clipIndex % workingClips.length];

      // Calculate how much time is available from this clip
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

  // ********************************************
  // New Montage Clips Processing Logic End Here
  // ********************************************

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(sourcePath)
      .input(audioPath);

    // Build FFmpeg filter graph
    const filters = [
       // First clip processing (video + audio from source)
      // `[0:v]trim=start=${timeToSeconds(firstClip.start_timestamp)}:duration=${firstClipDuration},setpts=PTS-STARTPTS[first_v];`,
      // `[0:a]atrim=start=${timeToSeconds(firstClip.start_timestamp)}:duration=${firstClipDuration},asetpts=PTS-STARTPTS[first_a];`,
      // Temporary change start 1st clip at 0 seconds
      `[0:v]trim=start=${timeToSeconds(0)}:duration=${firstClipDuration},setpts=PTS-STARTPTS[first_v];`,
      `[0:a]atrim=start=${timeToSeconds(0)}:duration=${firstClipDuration},asetpts=PTS-STARTPTS[first_a];`,

      // Last clip processing (video + audio from source)
      `[0:v]trim=start=${timeToSeconds(lastClip.start_timestamp)}:duration=${lastClipDuration},setpts=PTS-STARTPTS[last_v];`,
      `[0:a]atrim=start=${timeToSeconds(lastClip.start_timestamp)}:duration=${lastClipDuration},asetpts=PTS-STARTPTS[last_a];`,

      // Insert all montage clip segment filters (generated above)
      ...montageClipFilters,

      // Insert the montage concat filter
      montageConcatFilter,

      // Process audio track
      `[1:a]atrim=start=${alignedStart}:duration=${montageDuration},asetpts=PTS-STARTPTS[montage_a];`,

      // Final concatenation with proper audio mapping
      `[first_v][first_a] [montage_v][montage_a] [last_v][last_a] concat=n=3:v=1:a=1[full_v][full_a];`,

      // Add video and audio fade-out to black at the end
      `[full_v]fade=t=out:st=${fadeStart}:d=2[faded_v];`,
      `[full_a]afade=t=out:st=${fadeStart}:d=2[faded_a]`
    ];

    command.complexFilter(filters.join(''))
      .outputOptions([
        '-map', '[faded_v]',  // Use faded video stream
        '-map', '[faded_a]',  // Existing audio stream
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
        const geminiResponseData = await callGeminiAPI(sourceVideoGCSUrl);
        const intervals = calculateBeatIntervals(beatMarkers, reelRegion);

        updateRunStatus(runId, 'processing', 70, 'Rendering montage...');
        const [firstClip, ...restClips] = JSON.parse(geminiResponseData);
        const lastClip = restClips.pop();

        // temporary disable 1st and last clip functionality
        // const clipsData = restClips;
        const clipsData = JSON.parse(geminiResponseData);

        await createFinalMontage(
          sourceVideo,
          audioPath,
          intervals,
          clipsData,
          firstClip,
          lastClip,
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


// --------------------------
// Server Initialization
// --------------------------

// Empty downloads folder on server start
emptyDownloadsFolder();

app.listen(PORT, () => {
  // console.log(`Montage server running on http://localhost:${PORT}`);
  console.log(`Montage server running on port ${PORT}`);
});