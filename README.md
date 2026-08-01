[English](README.md) | [简体中文](README_CN.md)

# Gesture-Controlled 3D Particle System

An interactive browser-based particle experience that combines real-time 3D rendering with hand tracking. Three.js renders the particle scene, while MediaPipe Hands detects one hand through the webcam and maps palm gestures and movement to the animation.

The project uses plain web technologies, requires no package installation or API key, and runs locally through a development server.

## Features

- Real-time 3D particles with a glowing background star field
- Single-hand tracking through the webcam
- Open- and closed-palm gestures that expand and gather the particles
- Horizontal and vertical palm movement that rotates the particle form
- Four particle presets with smooth transitions
- Base color and particle density controls
- Mirrored, resizable camera preview
- Fullscreen mode with automatic button-state synchronization
- Slow automatic rotation when no hand is detected

## Technology Stack

- HTML
- CSS
- JavaScript
- Three.js `0.160.0`
- MediaPipe Hands `0.4.1675469240`

Three.js and MediaPipe Hands are loaded from jsDelivr, so an internet connection is required when the page loads.

## Run Locally

1. Open the project folder in VS Code.
2. Install the **Live Server** extension in VS Code.
3. In the Explorer panel, right-click `index.html`.
4. Select **Open with Live Server**.
5. When the page opens in your browser, allow camera access.

The page should open at an address beginning with `http://localhost` or `http://127.0.0.1`.

> Do not double-click `index.html` or open it directly with a `file://` URL. The application requires a secure local context to request camera access and will display an error when opened this way.

## Camera Permission

The application requests video access only; it does not request microphone access. After permission is granted, a mirrored camera preview appears in the lower-left corner. Place one hand fully inside the frame to begin controlling the particles.

If you previously denied access, open the site permissions from the icon beside the browser address bar, change the camera permission to **Allow**, and then select **Retry camera** on the page.

The camera preview can be resized by dragging its top edge, right edge, or upper-right corner.

## Gesture Controls

| Gesture or movement | Result |
| --- | --- |
| Open your palm | The particles spread outward completely. |
| Close your hand | The particles gather and return to the selected form. |
| Hold your hand partly open | The system keeps the previous open or closed state to avoid unstable transitions. |
| Move your palm left or right | Rotates the particle form around the Y axis. Rotation follows movement and stops when your hand stops. |
| Move your palm up or down | Tilts the particle form around the X axis. |
| Move your hand out of view | Returns the scene to slow automatic rotation. |

The tracker processes one hand and uses its detected landmarks to estimate palm openness and movement.

## Particle Presets

Use the control panel to switch among four generated particle arrangements:

- **Nebula** — a five-arm spiral cloud
- **Fireworks** — multiple spherical bursts and streaks
- **Saturn** — a particle planet surrounded by rings
- **Flower** — a seven-petal layered form

Changing presets smoothly morphs the existing particles into the new arrangement.

## Color and Particle Density

- **Base color:** Use the color picker to set the starting hue. The displayed color also shifts gradually with the model's rotation and animation time.
- **Particle density:** Use the slider to choose from 3,000 to 6,000 particles in steps of 500. The default is 3,500 particles.

Changing the density rebuilds the particle geometry for the currently selected preset.

## Fullscreen

Select the fullscreen button in the lower-right corner to enter or leave fullscreen mode. You can also press `Esc` to exit; the button label updates automatically when fullscreen state changes.

## Project Structure

```text
hand-particle/
├── index.html      # Page structure, controls, and CDN script loading
├── main.js         # Three.js scene, particles, hand tracking, and interactions
├── style.css       # Layout, visual design, and responsive styles
├── README.md       # English documentation
└── README_CN.md    # Simplified Chinese documentation
```

## Frequently Asked Questions

### Why is the page blank or the 3D scene missing?

- Confirm that the URL begins with `http://localhost` or `http://127.0.0.1`, not `file://`.
- Press `Ctrl + F5` to reload without the browser cache.
- Open the browser developer tools with `F12` and confirm in the Network panel that `style.css` and `main.js` load successfully.
- Make sure hardware acceleration is enabled, and temporarily disable browser extensions that may block WebGL or scripts.

### Why was camera access denied or why is there no video?

- Allow camera access for the current local site from the browser's site-permission controls.
- Close meeting, recording, or other software that may be using the camera exclusively.
- Select **Retry camera** on the page.
- On Windows, check **Settings > Privacy & security > Camera** and allow desktop applications to access the camera.
- For best compatibility, use a current version of Google Chrome or Microsoft Edge.

### Why did Three.js, MediaPipe, or the hand model fail to load?

The required scripts and MediaPipe model files are downloaded from `cdn.jsdelivr.net`. Check your internet connection, confirm that security software or a proxy is not blocking that domain, and reload the page with `Ctrl + F5`.

### Why do the particles rotate automatically?

Automatic rotation is the expected fallback when no hand has been detected recently. Move one hand fully into the camera frame to resume gesture control.
