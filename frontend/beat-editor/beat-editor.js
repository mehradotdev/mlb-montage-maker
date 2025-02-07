import { BACKEND_ENDPOINT } from '../main.js';
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";


// #region VARIABLES

const FRAME_DURATION = 1 / 59.94; // ~0.016683 seconds per frame
// const TOLERANCE_INTRVL = FRAME_DURATION;
// const DUP_MARKER_THRESH = FRAME_DURATION;
// const TOLERANCE_INTRVL = 0.01; // Tolerance interval in seconds for rounding and duplicate checking
// const DUP_MARKER_THRESH = 0.05; // Duplicate Threshold(in sec) to disallow user from placing a marker too close
const MIN_REEL_DURATION = 25; // Minimum reel duration in seconds
const MAX_REEL_DURATION = 60; // Maximum reel duration in seconds

let selectedMarker = null; // Variable to store the currently selected region
let reelRegion = null; // Variable to store the Reel Region
let playbackRestrictionIntervalId = null; // Variable to store the interval ID for playback restriction
let areYouAliveCheckDone = false; // Flag to ensure areYouAlive check runs only once

const audioFileInput = document.getElementById("audioFile");
const waveformContainer = document.getElementById("waveform");
const playbackSlider = document.getElementById("playbackSlider");
const zoomSlider = document.getElementById("zoomSlider");
const playPauseButton = document.getElementById("playPauseButton");
const markBeatButton = document.getElementById("markBeatButton");
const deleteMarkerButton = document.getElementById("deleteMarkerButton");
const exportButton = document.getElementById("exportButton");
const sampleMusicOptions = document.getElementById("sampleMusicOptions");
const deleteAllMarkersButton = document.getElementById("deleteAllMarkersButton");
const lockRegionCheckbox = document.getElementById("lockRegionCheckbox");
const musicNameDisplay = document.getElementById('musicNameText');
const generateMontageButton = document.getElementById("generateMontageButton");

const regions = RegionsPlugin.create();
const wavesurfer = WaveSurfer.create({
  container: waveformContainer,
  waveColor: "darkgrey",
  progressColor: "#EE772F",
  cursorColor: "grey",
  cursorWidth: 1,
  barWidth: 2,
  height: 300,
  barHeight: 0.75,
  responsive: true,
  dragToSeek: true,
  // mediaControls: true, // Keep media controls enabled for user's default playback
  audioRate: 1,
  plugins: [regions],
});
wavesurfer.toggleInteraction(false); // initially disable interaction

const sampleSongData = {
  "believe": {
    reelRegion: { start: 39.80, end: 88.12 }, // Example Reel Region for "Believe"
    beatMarkers: [
      42.01, 43.99, 46, 48.03, 50.01, 51.98, 54.01, 55.99, 58.03, 60.03, 62.01,
      64.01, 64.24, 64.58, 64.75, 65.06, 65.31, 65.55, 65.85, 66.07, 66.31, 66.56,
      66.8, 67.05, 67.32, 67.56, 67.82, 68.04, 68.23, 68.35, 68.48, 68.62, 68.77,
      68.91, 69.04, 69.17, 69.29, 69.42, 69.55, 69.67, 69.8, 69.91, 70.02, 70.61,
      71.19, 71.65, 72.09, 75.93, 80.04, 84.01
    ],
    displayName: "Believe (Instrumental) - NEFFEX",
    filename: "believe.ogg",
    audioSrc: "../music/believe.ogg",
  },
  "hows-it-supposed-to-feel": {
    reelRegion: { start: 0, end: 59.98 }, // Example Reel Region for "How's It Supposed to Feel" (adjust as needed)
    beatMarkers: [
      2.1, 4.2, 6.25, 8.36, 10.5, 11.41, 11.65, 12.58, 14.62, 16.7, 18.69, 19.76,
      19.98, 22.4, 25, 25.47, 26.14, 26.68, 27.21, 27.73, 28.19, 28.74, 29.27,
      29.84, 30.34, 30.82, 31.35, 31.89, 32.41, 32.64, 32.88, 33.38, 33.99, 34.47,
      35.01, 35.56, 36.06, 36.55, 37.05, 37.64, 38.12, 38.64, 39.13, 40.2, 40.97,
      41.24, 41.68, 42.36, 42.89, 43.38, 43.87, 44.41, 44.94, 45.43, 45.99, 46.49,
      47.02, 47.57, 48.06, 48.6, 49.11, 49.65, 50.16, 50.68, 51.18, 51.71, 52.27,
      52.75, 53.28, 53.71, 54.34, 54.85, 55.39, 55.87, 56.47, 57, 57.44, 57.67,
      57.92, 58.41
    ],
    displayName: "How's It Supposed to Feel (Instrumental) - NEFFEX",
    filename: "hows-it-supposed-to-feel.ogg",
    audioSrc: "../music/hows-it-supposed-to-feel.ogg",
  },
};
// #endregion


// #region HELPER FUNCTIONS

function clearSelectedMarker() {
  if (!selectedMarker) return;

  selectedMarker.setOptions({ content: "👇🏽" });
  selectedMarker = null;
  deleteMarkerButton.disabled = true;
}

function resetUIForAudioLoad() { // Helper function to reset UI elements
  playbackSlider.disabled = false;
  zoomSlider.disabled = false;
  playPauseButton.disabled = false;
  markBeatButton.disabled = false;
  deleteMarkerButton.disabled = true;
  exportButton.disabled = false;
  lockRegionCheckbox.disabled = false;
  lockRegionCheckbox.checked = false;
  deleteAllMarkersButton.disabled = false;
  generateMontageButton.disabled = false;
  regions.clearRegions(); // Clear all existing Markers and Reel Region first!
  wavesurfer.setTime(0);
  wavesurfer.toggleInteraction(true);
  clearSelectedMarker();

  zoomSlider.value = 0; // Reset zoom to default
  zoomSlider.dispatchEvent(new Event('input')); // Trigger input event to update zoom
  playbackSlider.value = 1; // Reset playback speed to default
  playbackSlider.dispatchEvent(new Event('input')); // Trigger input event to update playback rate

  // --- Clear the playback restriction interval ---
  if (playbackRestrictionIntervalId) {
    clearInterval(playbackRestrictionIntervalId);
    playbackRestrictionIntervalId = null; // Reset the interval ID
  }
  playPauseButton.textContent = "▶"; // Set Play icon initially
  musicNameDisplay.textContent = "Not selected...";
}

function createReelRegion(start = 0, end = MIN_REEL_DURATION) {
  const newReelRegion = regions.addRegion({
    id: "reel-region",
    start: start,
    end: end,
    minLength: MIN_REEL_DURATION,
    maxLength: MAX_REEL_DURATION,
    drag: true,
    resize: true,
    color: "rgba(255, 251, 0, 0.3)", // Semi-transparent Yellow
    // content: 'Reel Region (25-60s)'
  });

  return newReelRegion;
}

function createMarker(timestamp) {
  // console.log("Beat marked at:", timestamp);

  const marker = regions.addRegion({
    start: timestamp,
    content: "👇🏽",
    drag: true,
    resize: false,
  });

  marker.on("click", () => { // Add clickListener Event on this Marker
    clearSelectedMarker(); // Unselect any previously selected Marker
    selectedMarker = marker; // Set this Marker as selected
    marker.setOptions({ content: "👇🏿" }); // Highlight the selected Marker by changing emoji color
    deleteMarkerButton.disabled = false; // Enable Delete button
    console.log("Marker selected at:", marker.start);
  });

  return marker;
}

// function roundOffTimestamp(number) {
//   return parseFloat(
//     (Math.round(number / FRAME_DURATION) * FRAME_DURATION).toFixed(3)
//   );
// }
function roundOffTimestamp(number) {
  // Round to nearest frame boundary
  const frameNumber = Math.round(number / FRAME_DURATION);
  return parseFloat((frameNumber * FRAME_DURATION).toFixed(5));
}

function getBeatMarkers(regions) {
  const beatMarkers = regions.getRegions().reduce((acc, marker) => {
    const markerTimestamp = marker.start;

    if (marker.id === "reel-region") return acc; // Skip 'reel-region'
    if (markerTimestamp < reelRegion.start || markerTimestamp > reelRegion.end) return acc; // Skip out of bounds marker

    const newRoundedTimeFixed = roundOffTimestamp(markerTimestamp);
    acc.push(newRoundedTimeFixed);

    return acc;
  }, []);

  beatMarkers.sort((a, b) => a - b);

  return beatMarkers;
}

function togglePlayPause() {
  clearSelectedMarker();

  if (!reelRegion) return;

  if (wavesurfer.isPlaying()) {
    wavesurfer.pause();
    playPauseButton.textContent = "▶"; // Change to Play icon
  } else {
    // if we press play at end of reelRegion. Put playhead to start of reelRegion
    if (Math.abs(wavesurfer.getCurrentTime() - reelRegion.end) <= 0.1) wavesurfer.setTime(reelRegion.start);
    wavesurfer.play();
    playPauseButton.textContent = "▐▐"; // Change to Pause icon
  }
}

// --- Function to export beat timestamps ---
function exportBeatsAsJSON() {
  const beatTimestampsForExport = getBeatMarkers(regions);
  const jsonOutput = JSON.stringify(
    {
      reelRegion: { start: roundOffTimestamp(reelRegion.start), end: roundOffTimestamp(reelRegion.end) },
      beatMarkers: beatTimestampsForExport,
    },
    null,
    2
  );

  const blob = new Blob([jsonOutput], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "beats.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Function to call /areYouAlive API ---
async function checkAreYouAlive() {
  if (areYouAliveCheckDone) return; // Prevent multiple calls

  try {
    const response = await fetch(`${BACKEND_ENDPOINT}/areYouAlive`);
    if (!response.ok) {
      console.error('AreYouAlive check failed:', response.status, response.statusText);
    } else {
      const data = await response.json();
      console.log('AreYouAlive check successful:', data.message);
      areYouAliveCheckDone = true;
    }
  } catch (error) {
    console.error('Error during AreYouAlive check:', error);
  }
}

function startPlaybackRestriction() {
  // Interval to continuously check playback position and restrict it to reel region
  if (playbackRestrictionIntervalId) {
    return; // Interval already exists, do nothing
  }

  playbackRestrictionIntervalId = setInterval(() => { // Store the interval ID
    if (!reelRegion) return; // Exit if reel region is not set

    const currentTime = wavesurfer.getCurrentTime();

    if (currentTime < reelRegion.start || currentTime > reelRegion.end) {
      if (currentTime > reelRegion.end) {
        wavesurfer.setTime(reelRegion.end);
        wavesurfer.pause();
      }
      else wavesurfer.setTime(reelRegion.start);
    }
  }, 100); // Check every 100 milliseconds (adjust as needed)
}
// #endregion


// #region EVENT LISTENERS

audioFileInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await wavesurfer.loadBlob(file);
  reelRegion = createReelRegion(); // Create the Reel Region when audio is loaded
  audioFileInput.blur();

  musicNameDisplay.textContent = `${file.name}`; // Display uploaded file name
});

wavesurfer.on("ready", () => {
  console.log("Wavesurfer is ready. Audio loaded.");
  checkAreYouAlive();
  resetUIForAudioLoad(); // Reset UI when a new audio is loaded

  if (wavesurfer.getDuration() < 30 || wavesurfer.getDuration() > 900) {
    alert("Audio file should be longer than 30 seconds but shorter than 15 minutes.");
    window.location.reload(); // reload website
    return;
  }

  startPlaybackRestriction(); // Start playback restriction loop when ready
});

wavesurfer.on("error", (error) => {
  console.error("Error loading audio:", error);
  alert("Could not load audio file. Please check the file and try again.");
  window.location.reload();
});

// --- Add Event Listener for Export Button ---
exportButton.addEventListener("click", exportBeatsAsJSON);

// --- PLAY/PAUSE FUNCTIONALITY ---
playPauseButton.addEventListener("click", togglePlayPause);

// --- DELETE MARKER FUNCTIONALITY ---
deleteMarkerButton.addEventListener("click", () => {
  if (!selectedMarker) return;
  selectedMarker.remove();
  selectedMarker = null;
  deleteMarkerButton.disabled = true;
  console.log("Marker deleted.");
});

lockRegionCheckbox.addEventListener('change', (event) => {
  if (reelRegion) {
    reelRegion.setOptions({
      drag: !event.target.checked,
      color: event.target.checked ? "rgba(255, 136, 0, 0.3)" : "rgba(255, 251, 0, 0.3)", // Semi-transparent Orange when locked
      resize: !event.target.checked,
    });
    console.log("Reel Region drag " + (event.target.checked ? "disabled" : "enabled"));
  }
  lockRegionCheckbox.blur();
});

zoomSlider.addEventListener("input", (e) => {
  const zoomLevel = e.target.valueAsNumber;
  document.querySelector("#zoomLabel").textContent = 100 + zoomLevel;
  wavesurfer.zoom(e.target.valueAsNumber);
  zoomSlider.blur();
});

playbackSlider.addEventListener("input", (e) => {
  const playbackSpeed = e.target.valueAsNumber;
  document.querySelector("#rateLabel").textContent = playbackSpeed;
  wavesurfer.setPlaybackRate(playbackSpeed, true);
  playbackSlider.blur();
  // wavesurfer.play();
});

markBeatButton.addEventListener("click", () => {
  const currentMarkerTime = wavesurfer.getCurrentTime();
  let markerExistsNearby = false;

  // Check for duplicate/nearby markers
  markerExistsNearby = regions.getRegions().some(marker => {
    if (marker.id === "reel-region") return false; // Skip 'reel-region'
    return Math.abs(marker.start - currentMarkerTime) <= FRAME_DURATION;
  });

  if (!markerExistsNearby) { createMarker(currentMarkerTime); }
  else {
    console.log("Marker already exists at:", currentMarkerTime);
    alert("A beat marker already exists close to this position!");
  }
});

// --- Sample Music Button Event Listener ---
sampleMusicOptions.addEventListener("click", async (event) => {
  if (event.target.tagName !== "BUTTON") return;
  const trackName = event.target.dataset.track;
  const songData = sampleSongData[trackName];
  audioFileInput.value = null; // clear upload button value

  await wavesurfer.load(songData.audioSrc);
  console.log('start marking!');

  reelRegion = createReelRegion(songData.reelRegion.start, songData.reelRegion.end);
  songData.beatMarkers.forEach(beatTime => createMarker(beatTime));

  musicNameDisplay.textContent = `${songData.filename}`; // Update music name display with sample song name
});

// --- DELETE ALL MARKERS FUNCTIONALITY ---
deleteAllMarkersButton.addEventListener("click", () => {
  if (window.confirm("Are you sure you want to delete all beat markers?")) {
    regions.getRegions().forEach(region => {
      if (region.id !== "reel-region") { // Delete only beat markers, not Reel Region
        region.remove();
      }
    });
    clearSelectedMarker(); // Clear selected marker if any was selected
    console.log("All beat markers deleted.");
  }
});

generateMontageButton.addEventListener("click", async () => {
  generateMontageButton.disabled = true; // Disable button immediately

  const gameNameDisplay = document.getElementById('gameNameText');
  const musicNameDisplayElement = document.getElementById('musicNameText');
  const urlParams = new URLSearchParams(window.location.search);

  const gamePk = urlParams.get('gamePk');
  const gameName = gameNameDisplay.textContent;
  const musicName = musicNameDisplayElement.textContent;
  const audioFile = audioFileInput.files[0]; // Get the uploaded audio file
  const beatMarkersForExport = getBeatMarkers(regions);

  const montageData = {
    gamePk: gamePk,
    gameName: gameName,
    musicName: musicName,
    reelRegion: {
      start: roundOffTimestamp(reelRegion.start),
      end: roundOffTimestamp(reelRegion.end),
    },
    beatMarkers: beatMarkersForExport,
  };

  const formData = new FormData();
  formData.append('montageData', JSON.stringify(montageData)); // Append montage data

  if (audioFile) {
    formData.append('audioFile', audioFile); // Append audio file if it exists (custom upload)
  } else {
    // Handle sample music case if needed. For now, assuming backend has access to sample music.
    // You might send a 'sampleMusicName' in montageData if backend needs to identify sample music.
    console.log("Using sample music (no audio file uploaded).");
  }

  try {
    const response = await fetch(`${BACKEND_ENDPOINT}/initMontageCreation`, { // Changed API endpoint
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const message = `Error: ${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    const responseData = await response.json();
    const runId = responseData.runId; // Get runId from response

    if (!runId) {
      throw new Error("runId not received from server.");
    }

    // Redirect to montage video page with runId
    window.location.href = `../montage-viewer/?runId=${runId}`;


  } catch (error) {
    console.error("Error initializing montage request:", error);
    alert(`Failed to initialize montage request. Error: ${error.message}`); // Basic error feedback
    generateMontageButton.disabled = false; // Re-enable button in case of error
  }
});

// --- KEYBOARD SHORTCUTS ---
document.addEventListener('keydown', (event) => {
  // if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
  if (event.target.tagName === 'TEXTAREA') {
    return; // Don't activate shortcuts if typing in input/textarea
  }

  switch (event.key) {
    case ' ': // Spacebar for Play/Pause
      event.preventDefault(); // Prevent spacebar from scrolling the page
      togglePlayPause();
      break;
    case 'f': // 'f' key for Mark Beat
    case 'F':
      markBeatButton.click();
      break;
    case 'r': // 'r' key for Reset Playback Speed and Zoom Level  <--- Changed functionality
    case 'R':
      if (wavesurfer.getDuration() > 0) {
        playbackSlider.value = 1; // Reset playback speed to default (1x)
        playbackSlider.dispatchEvent(new Event('input')); // Trigger input event to update playback rate

        zoomSlider.value = 0; // Reset zoom level to default (100%)
        zoomSlider.dispatchEvent(new Event('input')); // Trigger input event to update zoom
        break;
      }
    case 'a': // 'a' key for Delete Selected Marker
    case 'A':
      deleteMarkerButton.click();
      break;
    case 'w': // 'w' key for Zoom Out timeline
    case 'W':
      if (wavesurfer.getDuration() > 0) {
        zoomSlider.value = Math.max(0, parseInt(zoomSlider.value) - 10); // Zoom out by 10, min 0
        zoomSlider.dispatchEvent(new Event('input')); // Trigger input event to update zoom
      }
      break;
    case 'e': // 'e' key for Zoom In timeline
    case 'E':
      if (wavesurfer.getDuration() > 0) {
        zoomSlider.value = Math.min(150, parseInt(zoomSlider.value) + 10); // Zoom in by 10, max 150
        zoomSlider.dispatchEvent(new Event('input')); // Trigger input event to update zoom
      }
      break;
    case 's': // 's' key for Slow playback speed
    case 'S':
      if (wavesurfer.getDuration() > 0) {
        playbackSlider.value = Math.max(0.25, parseFloat(playbackSlider.value) - 0.05).toFixed(2); // Decrease speed by 0.05, min 0.25
        playbackSlider.dispatchEvent(new Event('input')); // Trigger input event to update playback rate
        break;
      }
    case 'd': // 'd' key for Speed up playback speed
    case 'D':
      if (wavesurfer.getDuration() > 0) {
        playbackSlider.value = Math.min(2, parseFloat(playbackSlider.value) + 0.05).toFixed(2); // Increase speed by 0.05, max 2
        playbackSlider.dispatchEvent(new Event('input')); // Trigger input event to update playback rate
        break;
      }
    case 'q': // 'q' key for Toggle Lock Reel Region Checkbox
    case 'Q':
      if (!reelRegion) return;
      lockRegionCheckbox.checked = !lockRegionCheckbox.checked; // Toggle checkbox state
      lockRegionCheckbox.dispatchEvent(new Event('change'));     // Trigger 'change' event to update drag
      break;
    // Add more keybinds here if needed
  }
});
// #endregion
