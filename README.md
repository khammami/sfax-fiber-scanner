# Sfax Fiber (GPON) Coverage Scanner

A standalone web application that systematically scans the Sfax, Tunisia region to check fiber (GPON) coverage using the Tunisie Telecom API. The app displays results on an interactive map with comprehensive statistics and export capabilities.

## Features

- 🗺️ **Interactive Map**: Built with Leaflet.js and OpenStreetMap tiles
- 🔍 **Fine Grid Scanning**: Configurable scan area and grid density (~200m between points)
- 📊 **Real-time Visualization**: Circle markers with color coding (green=available, red=not available, yellow=error)
- 📈 **Progress Tracking**: Live progress bar and statistics during scanning
- 🔄 **Retry Not Available Points**: Re-scan points that were marked as "Not Available" to check if status has changed
- 🔥 **Heatmap Layer**: Optional heatmap visualization of coverage data
- 📥 **Export Results**: Download scan data as JSON or CSV
- 💾 **Results Persistence**: Automatic saving to localStorage with restore on page load
- 🎯 **Custom Bounds**: Draw rectangles on the map to define custom scan areas
- ⚙️ **Configurable Settings**: Adjust scan bounds, step size, and API request delay
- 📱 **Responsive Design**: Works on desktop and mobile devices

## Local Development

To run the app locally without CORS errors, use the built-in dev server:

```bash
npm install
npm run dev
```

Then open **http://localhost:3000** in your browser.

The dev server:
- Serves `index.html`, `script.js`, `style.css`, and other static files
- Proxies API requests from `/api/rsm/*` to `https://geo.tunisietelecom.tn/rsm/*`

> [!WARNING]
> Opening `index.html` directly as a file (`file://`) or via a simple file server that does not proxy API calls will result in CORS errors because the browser blocks cross-origin requests to `geo.tunisietelecom.tn`.

## How to Use

1. **Open the Application**
   - Run `npm run dev` and open **http://localhost:3000** (see [Local Development](#local-development) above)
   - Or deploy to GitHub Pages / a custom domain — API calls go directly without a proxy

2. **Configure Scan Area**
   - Use the default Sfax region bounds (34.70-34.78 lat, 10.72-10.80 lng)
   - Or adjust the latitude/longitude min/max values in the control panel
   - Or enable "Draw Custom Bounds" and draw a rectangle on the map

3. **Adjust Settings**
   - **Step Size**: Distance between scan points in degrees (default: 0.002° ≈ 200m)
   - **Delay**: Time between API requests in milliseconds (default: 500ms)
   - The app automatically calculates the total number of points

4. **Start Scanning**
   - Click "Start Scan" to begin
   - Use "Pause" to temporarily stop (resume later)
   - Use "Stop" to end the scan completely
   - Progress is shown in real-time with a progress bar

5. **View Results**
   - 🟢 Green markers = Fiber (GPON) available
   - 🔴 Red markers = Fiber not available
   - 🟡 Yellow markers = Error or skipped points
   - Click any marker to see detailed information

6. **Export & Save**
   - Click "Export JSON" or "Export CSV" to download results
   - Results are automatically saved to browser localStorage
   - Reload the page to restore previous scan data

7. **Retry Not Available Points**
   - After completing a scan, click "🔄 Retry Not Available" to re-scan points marked as "Not Available"
   - Useful for checking if fiber coverage has been deployed to previously unavailable locations
   - The system will show how many points to retry and update statistics
   - Updated markers will reflect the new status (may become available or remain unavailable)

## How It Works

### Token Generation

The Tunisie Telecom API requires a unique token for each request:

1. Fetch server time from `getAppVersion` endpoint
2. Extract and decode the timestamp
3. Calculate token value using specific offsets
4. Append a 10-character random string
5. **Each API request generates its own fresh token**

```javascript
async function getToken() {
    const response = await fetch("https://geo.tunisietelecom.tn/rsm/RSMService.svc/getAppVersion");
    const data = await response.json();
    // ... token calculation logic
    return token;
}

async function checkCoverage(lat, lng) {
    // Generate fresh token for this specific request
    const token = await getToken();
    // ... make API call with token
}
```

### Coordinate Encoding

Coordinates are encoded before being sent to the API:

```javascript
function codeCoordinates(x, y) {
    const Ax = 100000.0, Ay = 100000.0;
    const Bx = 123456.0, By = 654321.0;
    return { 
        xCoded: (x * Ax) - Bx, 
        yCoded: (y * Ay) - By 
    };
}
```

### Coverage Check

For each point in the grid:
1. Encode the coordinates
2. Send POST request to `TaghtiaUltimate` endpoint
3. Check response for GPON availability
4. Display result on map with appropriate color
5. Add retry logic for failed requests

### Grid Scanning

The application generates a grid of points based on:
- Latitude range (min to max)
- Longitude range (min to max)
- Step size (default 0.002° ≈ 200 meters)

Points are scanned sequentially with configurable delays between requests.

## Technical Stack

- **HTML5** - Application structure
- **CSS3** - Styling and responsive design
- **JavaScript (ES6+)** - Core logic and API integration
- **Leaflet.js 1.9.4** - Interactive map library
- **Leaflet.draw** - Rectangle drawing for custom bounds
- **Leaflet.heat** - Heatmap visualization
- **Bootstrap 5.3** - UI components and responsive grid
- **OpenStreetMap** - Free map tiles (no API key required)

## API Reference

This application uses the Tunisie Telecom coverage API (reverse-engineered):

**Base URL**: `https://geo.tunisietelecom.tn/rsm/RSMService.svc/`

**Endpoints**:
- `getAppVersion` - Get server time for token generation
- `TaghtiaUltimate` - Check coverage for coordinates

**GPON Availability Check**:
```javascript
if (result.taghtiaGPON.Code_taghtia == 200 && 
    result.taghtiaGPON.Message_taghtia == "OK" && 
    result.taghtiaGPON.Taghtia == "OUI") {
    // GPON Fiber is available
}
```

## Browser Compatibility

- ✅ Chrome/Edge (v90+)
- ✅ Firefox (v88+)
- ✅ Safari (v14+)
- ✅ Mobile browsers (iOS Safari, Chrome Mobile)

## Project Structure

```
sfax-fiber-scanner/
├── index.html      # Main HTML page with map and UI
├── style.css       # Styles and responsive design
├── script.js       # JavaScript logic and API integration
├── server.js       # Local dev server with API proxy (Node.js)
├── package.json    # npm dependencies and dev script
└── README.md       # This file
```

## Credits

This project is inspired by and uses API information reverse-engineered from:
- [Jev1337/More-Taghtia](https://github.com/Jev1337/More-Taghtia)

## Disclaimer

⚠️ **Important**: This application is for **educational purposes only**. 

- The API used belongs to **Tunisie Telecom** and is not officially public
- This tool should be used responsibly and not for commercial purposes
- The author is not responsible for any misuse of this application
- Please respect rate limits and do not overload the API servers
- This is an unofficial tool and is not affiliated with Tunisie Telecom

## License

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter any issues or have questions, please open an issue on GitHub.

---

**Made with ❤️ for the Sfax community**
