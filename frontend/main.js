import posthog from 'posthog-js';

export const POSTHOG_PROJECT_KEY = 'phc_7mxfX8NwwP9KA8MUqN5QLhnpYtVeBYdK5WJ3qwvLHyl';
// export const BACKEND_ENDPOINT = 'http://localhost:3000'; // Default endpoint for development
export const BACKEND_ENDPOINT = 'https://mlb-montage-maker-backend.mehra.dev';

export function initPosthog() {
  if (!window.location.host.includes('127.0.0.1') && !window.location.host.includes('localhost')) {
    posthog.init(POSTHOG_PROJECT_KEY,
      {
        api_host: `${BACKEND_ENDPOINT}/ingest`,
        ui_host: 'https://eu.posthog.com',
      }
    );
  }
}
