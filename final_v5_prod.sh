cat <<EOF > app/src/main/assets/www/index_v3s.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>XiaoMi Box 3S Pro</title>
    <script src="scripts/mqtt.min.js"></script>
    <script src="https://cdn.bootcdn.net/ajax/libs/pdf.js/2.10.377/pdf.min.js"></script>
    <style>
        :root { --bg: #000; --text: #0f0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: var(--bg); color: #fff; font-family: sans-serif; overflow: hidden; width: 100vw; height: 100vh; }
        
        /* ???? */
        #display-container { position: absolute; top: 0; left: 0; width: 100%; height: 70%; display: flex; align-items: center; justify-content: center; background: #000; z-index: 10; }
        #placeholder { text-align: center; }
        #media-layer { width: 100%; height: 100%; display: none; background: #000; position: relative; }
        canvas, img, video, iframe { max-width: 100%; max-height: 100%; }

        /* ???? */
        #tv-log { position: absolute; bottom: 0; left: 0; width: 100%; height: 30%; background: rgba(10,10,10,0.95); border-top: 2px solid var(--text); color: var(--text); font-size: 14px; padding: 10px; overflow-y: auto; z-index: 100; pointer-events: none; }
        .log-item { margin-bottom: 2px; }
        .success { color: #0f0; }
        .error { color: #f44; }
        .info { color: #0cf; }
    </style>
</head>
<body>
    <div id="display-container">
        <div id="placeholder">
            <h1 style="color: #0cf; font-size: 40px;">WAITING SIGNAL</h1>
            <p id="room-info" style="color: #888; margin-top: 10px;"></p>
        </div>
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

        var BEMFA_KEY = '3eb42d69d8b226abe22024d648975f8a';
        var MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
        var BASE_TOPIC = BEMFA_KEY + '/PPT001';
        var CID = 'TV_' + Math.floor(Math.random()*100000);
        
        window.onload = function() {
            log('=== PRODUCTION V5 START ===', 'info');
            
            // ????
            var room = (new RegExp("[?&]room=([^&]+)").exec(location.search) || [])[1];
            var finalTopic = BASE_TOPIC;
            if (room) {
                document.getElementById('room-info').innerText = 'Room: ' + room;
                var h = 2166136261;
                var input = BEMFA_KEY + ":" + room;
                for (var i = 0; i < input.length; i++) {
                    h ^= input.charCodeAt(i);
                    h = Math.imul(h, 16777619);
                }
                var sig = (h >>> 0).toString(16);
                while(sig.length < 8) sig = '0' + sig;
                finalTopic += "_" + room + "_" + sig;
                log('Room Signature: ' + sig, 'info');
            }
            log('Target Topic: ' + finalTopic, 'info');

            if (typeof mqtt === 'undefined') {
                log('CRITICAL: MQTT library missing!', 'error'); return;
            }

            try {
                var client = mqtt.connect(MQTT_URL, {
                    clientId: CID, clean: true, connectTimeout: 5000,
                    reconnectPeriod: 3000, protocolVersion: 4
                });

                client.on('connect', function() {
                    log('NETWORK: CONNECTED SUCCESS', 'success');
                    client.subscribe(finalTopic);
                    log('SUBSCRIPTION: ACTIVE');
                });

                client.on('message', function(t, m) {
                    var msg = m.toString();
                    log('RECV: ' + msg);
                    try { handleAction(JSON.parse(msg)); } catch(e) { log('PARSE ERR: ' + e.message, 'error'); }
                });

                client.on('error', function(e) { log('MQTT ERR: ' + e.message, 'error'); });
            } catch (e) { log('CRASH: ' + e.message, 'error'); }
        };

        function handleAction(data) {
            var layer = document.getElementById('media-layer');
            var holder = document.getElementById('placeholder');
            holder.style.display = 'none';
            layer.style.display = 'block';
            layer.innerHTML = '';

            var type = data.t || 'image';
            var url = data.u || data.url;
            if (!url) return;

            if (type === 'image') {
                var img = new Image();
                img.src = url;
                img.style.objectFit = data.fit || 'contain';
                layer.appendChild(img);
            } else if (type === 'video') {
                var v = document.createElement('video');
                v.src = url; v.autoplay = true; v.controls = true;
                v.style.width = '100%'; v.style.height = '100%';
                layer.appendChild(v);
            } else if (type === 'pdf') {
                var canvas = document.createElement('canvas');
                layer.appendChild(canvas);
                renderPDF(url, data.pg || 1, canvas);
            }
        }

        function renderPDF(url, pg, canvas) {
            pdfjsLib.getDocument(url).promise.then(function(pdf) {
                pdf.getPage(pg).then(function(page) {
                    var viewport = page.getViewport({ scale: 1.5 });
                    var context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    page.render({ canvasContext: context, viewport: viewport });
                });
            });
        }
    </script>
</body>
</html>
EOF
