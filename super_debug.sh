cat <<EOF > app/src/main/assets/www/index_v3s.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>XiaoMi Box Super Debug</title>
    <script src="scripts/mqtt.min.js"></script>
    <script src="https://cdn.bootcdn.net/ajax/libs/pdf.js/2.10.377/pdf.min.js"></script>
    <style>
        :root { --bg: #000; --text: #0f0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: var(--bg); color: #fff; font-family: monospace; overflow: hidden; width: 100vw; height: 100vh; }
        
        /* ?????? */
        #sys-info { position: absolute; top: 0; left: 0; width: 100%; height: 30px; background: #222; font-size: 12px; display: flex; align-items: center; padding: 0 10px; color: #aaa; z-index: 1000; }
        
        /* ??? */
        #display-container { position: absolute; top: 30px; left: 0; width: 100%; height: 50%; background: #111; display: flex; align-items: center; justify-content: center; z-index: 10; border-bottom: 2px solid #333; }
        #media-layer { width: 100%; height: 100%; display: none; }
        canvas, img, video { max-width: 100%; max-height: 100%; object-fit: contain; }

        /* ?????? (?????) */
        #sim-bar { position: absolute; top: 40px; right: 10px; z-index: 1001; }
        button { background: #333; color: #0f0; border: 1px solid #0f0; padding: 5px 10px; cursor: pointer; margin-left: 5px; font-size: 12px; }

        /* ??? */
        #tv-log { position: absolute; bottom: 0; left: 0; width: 100%; height: 45%; background: rgba(0,0,0,0.95); color: var(--text); font-size: 13px; padding: 10px; overflow-y: auto; z-index: 100; }
        .log-item { margin-bottom: 2px; }
        .success { color: #0f0; font-weight: bold; }
        .error { color: #f44; }
        .cmd { color: #ff0; }
    </style>
</head>
<body>
    <div id="sys-info">LOADING SYSTEM INFO...</div>
    <div id="sim-bar">
        <button onclick="simulate('image')">????</button>
        <button onclick="simulate('video')">????</button>
        <button onclick="simulate('pdf')">??PDF</button>
    </div>
    <div id="display-container">
        <div id="placeholder"><h2 style="color: #444;">WAITING MQTT COMMAND...</h2></div>
        <div id="media-layer"></div>
    </div>
    <div id="tv-log"></div>

    <script>
        function log(msg, type) {
            var p = document.getElementById('tv-log');
            var d = document.createElement('div');
            d.className = 'log-item ' + (type || '');
            d.innerHTML = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            p.appendChild(d);
            p.scrollTop = p.scrollHeight;
        }

        window.onload = function() {
            var ua = navigator.userAgent;
            document.getElementById('sys-info').innerText = 'UA: ' + ua.substring(0, 80) + ' | RES: ' + window.innerWidth + 'x' + window.innerHeight;
            log('=== SUPER DEBUG START ===', 'success');
            
            initMQTT();
        };

        function initMQTT() {
            var MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
            var TOPIC = '3eb42d69d8b226abe22024d648975f8a/PPT001';
            var CID = 'TV_' + Math.floor(Math.random()*100000);
            
            log('MQTT Connecting: ' + MQTT_URL, 'info');
            try {
                var client = mqtt.connect(MQTT_URL, { clientId: CID, protocolVersion: 4 });
                client.on('connect', function() {
                    log('NETWORK: CONNECTED!', 'success');
                    client.subscribe(TOPIC);
                });
                client.on('message', function(t, m) {
                    log('MQTT RECV: ' + m.toString(), 'cmd');
                    handleAction(JSON.parse(m.toString()));
                });
                client.on('error', function(e) { log('MQTT ERR: ' + e.message, 'error'); });
            } catch(e) { log('CRITICAL CRASH: ' + e.message, 'error'); }
        }

        function simulate(type) {
            log('SIMULATING: ' + type, 'success');
            var mock = {
                image: { t: 'image', u: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800' },
                video: { t: 'video', u: 'http://vjs.zencdn.net/v/oceans.mp4' },
                pdf: { t: 'pdf', u: 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf', pg: 1 }
            };
            handleAction(mock[type]);
        }

        function handleAction(data) {
            var layer = document.getElementById('media-layer');
            document.getElementById('placeholder').style.display = 'none';
            layer.style.display = 'block';
            layer.innerHTML = '';

            var url = data.u || data.url || data.pdfUrl;
            var type = data.t || data.type || 'image';

            if (type === 'image') {
                layer.innerHTML = '<img src="' + url + '">';
            } else if (type === 'video') {
                layer.innerHTML = '<video src="' + url + '" autoplay controls style="width:100%;"></video>';
            } else if (type === 'pdf') {
                layer.innerHTML = '<canvas id="pdf-canvas"></canvas>';
                renderPDF(url, data.pg || 1);
            }
        }

        function renderPDF(url, pg) {
            pdfjsLib.getDocument(url).promise.then(function(pdf) {
                pdf.getPage(pg).then(function(page) {
                    var canvas = document.getElementById('pdf-canvas');
                    var viewport = page.getViewport({ scale: 1.0 });
                    var context = canvas.getContext('2d');
                    canvas.height = viewport.height; canvas.width = viewport.width;
                    page.render({ canvasContext: context, viewport: viewport });
                });
            }).catch(e => log('PDF ERR: ' + e.message, 'error'));
        }
    </script>
</body>
</html>
EOF
