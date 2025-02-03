import { BACKEND_ENDPOINT } from '../main.js';
import confetti from "canvas-confetti";

const montageTitleElement = document.getElementById('montageTitle'); // Get title element
const progressMessageElement = document.getElementById('progressMessage');
const montageProgressLvlDisplayElement = document.getElementById('montageProgressLvlDisplay'); // Get progress display element
const videoPlayer = document.getElementById('montageVideoPlayer');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const generatingOverlay = document.getElementById('generatingOverlay');
const errorDisplay = document.getElementById('errorDisplay');
const encouragingMessageElement = document.getElementById('encouragingMessage');
const downloadButton = document.getElementById('downloadButton'); // Get download button
const newMontageButton = document.getElementById('newMontageButton');
const videoDeletionWarningElement = document.getElementById('videoDeletionWarning'); // Get the new warning element

const encouragingMessages = [
  "Your montage is being crafted with precision!",
  "Getting ready to showcase the best baseball moments to your beat!",
  "Synchronizing beats with baseball magic...",
  "Compiling the highlights...",
  "Almost there! Just a few more moments...",
  "Adding the final touches...",
];
let messageIndex = 0;

function cycleEncouragingMessages() {
  encouragingMessageElement.textContent = encouragingMessages[messageIndex];
  messageIndex = (messageIndex + 1) % encouragingMessages.length;
}

export function startMontageStatusPolling(runId) {
  let retryCount = 0;
  let fakeProgress = 0; // Initialize fake progress
  const maxRetries = 5; // Maximum retry attempts before giving up
  let pollingIntervalId;
  let fakeProgressIntervalId; // Interval ID for fake progress

  // Start cycling encouraging messages
  cycleEncouragingMessages(); // Display first message immediately
  const messageCycleIntervalId = setInterval(cycleEncouragingMessages, 13_000); // Change message every 13 seconds

  // Start fake progress
  montageProgressLvlDisplayElement.style.display = 'block'; // Show progress display
  fakeProgressIntervalId = setInterval(() => {
    if (fakeProgress < 99) fakeProgress++;
    montageProgressLvlDisplayElement.textContent = `Montage progress: ${fakeProgress}% completed...`;
  }, 2000); // Increment fake progress every 2 seconds

  // --- Show video deletion warning message at start ---
  videoDeletionWarningElement.textContent = "🚨 Alert: To manage server space, Your generated videos will be deleted after a short period. Make sure to download it before it's gone forever! ⏳";
  videoDeletionWarningElement.style.display = 'block'; // Show the warning message

  function fetchMontageStatus() {
    fetch(`${BACKEND_ENDPOINT}/montageStatus?runId=${runId}`)
      .then(response => {
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('RunId not found on server.'); // Specific error for 404
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        if (data.status === 'completed') {
          clearInterval(pollingIntervalId); // Stop polling when completed
          clearInterval(messageCycleIntervalId); // Stop cycling messages
          clearInterval(fakeProgressIntervalId); // Stop fake progress interval

          confetti({ // show confetti
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
          });

          montageTitleElement.textContent = '🎉 Yay! Your Baseball Montage is ready! 🥳'; // Update title
          // progressMessageElement.style.display = 'none'; // Hide "Generating montage..." message
          montageProgressLvlDisplayElement.textContent = `Montage progress: 100% completed!`; // Final progress message
          generatingOverlay.style.display = 'none';
          videoPlaceholder.classList.add('ready'); // Remove placeholder styling
          videoPlayer.src = `${BACKEND_ENDPOINT}${data.finishedMontageUrl}`;
          videoPlayer.style.display = 'block';
          videoPlayer.focus(); // Optional: focus the video player for immediate controls
          downloadButton.href = `${BACKEND_ENDPOINT}${data.finishedMontageUrl}`; // Set download URL
          downloadButton.style.display = 'block'; // Show download button
          newMontageButton.style.display = 'block';

          // --- Show and set text for video deletion warning ---
          videoDeletionWarningElement.style.display = 'none'; // Hide the warning message
        } else if (data.status === 'processing' || data.status === 'pending') {
          // const displayProgress = Math.max(fakeProgress, data.progress); // Take maximum of fake and API progress
          fakeProgress = fakeProgress > data.progress ? fakeProgress : data.progress;
          montageProgressLvlDisplayElement.textContent = `Montage progress: ${fakeProgress}% completed...`;
          progressMessageElement.textContent = data.progressMessage || `Generating montage...`;
          retryCount = 0; // Reset retry counter on successful status update
        } else if (data.status === 'failed') {
          clearInterval(pollingIntervalId); // Stop polling on failure
          clearInterval(messageCycleIntervalId); // Stop cycling messages
          clearInterval(fakeProgressIntervalId); // Stop fake progress interval
          progressMessageElement.textContent = data.progressMessage || 'Montage generation failed.';
          // montageProgressDisplayElement.style.display = 'none'; // Hide progress display on failure
          generatingOverlay.style.display = 'none'; // Optionally hide overlay
          errorDisplay.textContent = 'Montage generation failed. Please try again. If the issue persists, contact support.';
          errorDisplay.style.display = 'block';
        } else {
          console.warn('Unknown status:', data.status); // Log unexpected status
          progressMessageElement.textContent = 'Waiting for status update...'; // Fallback message
        }
      })
      .catch(error => {
        console.error('Error fetching montage status:', error);
        retryCount++;
        if (retryCount > maxRetries) {
          clearInterval(pollingIntervalId); // Stop polling after max retries
          clearInterval(messageCycleIntervalId); // Stop cycling messages
          clearInterval(fakeProgressIntervalId); // Stop fake progress interval
          progressMessageElement.textContent = 'Failed to get status after multiple retries.';
          // montageProgressDisplayElement.style.display = 'none'; // Hide progress display on retry failure
          generatingOverlay.style.display = 'none'; // Optionally hide overlay
          errorDisplay.textContent = 'Failed to connect to server to get montage status. Please check your connection and try again later.';
          errorDisplay.style.display = 'block';
        } else {
          progressMessageElement.textContent = `Retrying status fetch... attempt ${retryCount}/${maxRetries}`;
          fakeProgress = 0;
        }
      });
  }

  pollingIntervalId = setInterval(fetchMontageStatus, 5000); // Poll every 5 seconds
  fetchMontageStatus(); // Call immediately once to start
}
