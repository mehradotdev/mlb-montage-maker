import Hls from 'hls.js';

function createHlsPlayer(m3u8Url, videoElementId) {
  const video = document.getElementById(videoElementId);
  if (!video) {
    console.error('Video element not found with ID:', videoElementId);
    return null;
  }

  let hls = null;

  if (Hls.isSupported()) {
    hls = new Hls({
      startLevel: 0,           // Start with the lowest quality level
      minAutoBitrate: 0,      // Allow automatic bitrate switching down to 0 bps
      maxBufferHole: 0.5,      // Allow up to 0.5 seconds of buffer holes
      maxMaxBufferLength: 90,  // Increased maxMaxBufferLength to 90 seconds (from 60)
      bufferGoal: 60,         // Added bufferGoal, set to 60 seconds (adjust as needed)
      abrMaxBitrate: 10000000, // Limit ABR to a max bitrate (e.g., 10 Mbps - adjust as needed)
    });

    hls.loadSource(m3u8Url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play(); // Autoplay after manifest is parsed (optional)
    });
    hls.on(Hls.Events.ERROR, function (event, data) {
      const errorType = data.type;
      const errorDetails = data.details;
      const errorFatal = data.fatal;

      console.error("HLS.js error:", errorType, errorDetails, "Fatal:", errorFatal);

      if (errorType === Hls.ErrorTypes.NETWORK_ERROR) {
        console.error("HLS.js Network Error:", errorDetails, "Fatal:", errorFatal);
        // You might want to add retry logic here for network errors if needed
      } else if (errorType === Hls.ErrorTypes.MEDIA_ERROR) {
        console.error("HLS.js Media Error:", errorDetails, "Fatal:", errorFatal);
        // Media errors are often more serious and might indicate stream issues
        if (errorDetails === 'bufferAppendError') {
          console.error("HLS.js Buffer Append Error Details:", data);
        } else if (errorDetails === 'bufferStalledError') {
          console.error("HLS.js Buffer Stalled Error Details:", data);
        }

        if (errorFatal) {
          alert("A fatal media error occurred. Playback may be disrupted."); // Keep alert for fatal media errors
        } else {
          console.warn("Non-fatal media error encountered. Playback might be slightly affected."); // Warn for non-fatal
        }
      } else {
        console.error("HLS.js General Error:", errorType, errorDetails, "Fatal:", errorFatal);
        if (errorFatal) {
          alert("A fatal error occurred with HLS.js. Playback may be disrupted.");
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (e.g., Safari, some Android browsers)
    video.src = m3u8Url;
    video.addEventListener('loadedmetadata', function () {
      video.play(); // Autoplay for native HLS (optional)
    });
    video.addEventListener('error', function(event) {
      console.error("Native HLS playback error", event); // Log native HLS errors too
      alert("A native HLS playback error occurred.");
    });
  } else {
    console.error('HLS is not supported on this browser.');
    alert("Your browser does not support HLS playback. Please use a modern browser like Chrome, Firefox, Safari, or Edge.");
  }
  return hls; // Return the hls instance (could be null if Hls.isSupported() is false)
}

export default createHlsPlayer;