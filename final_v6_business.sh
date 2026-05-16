cat <<EOF > app/src/main/assets/www/index_v3s.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>XiaoMi Box 3S Full Business</title>
    <script src="scripts/mqtt.min.js"></script>
    <script src="https://cdn.bootcdn.net/ajax/libs/pdf.js/2.10.377/pdf.min.js"></script>
    <style>
        :root { --bg: #000; --text: #0f0; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: var(--bg); color: #fff; font-family: sans-serif; overflow: hidden; width: 100vw; height: 100vh; }
        #display-container { position: absolute; top: 0; left: 0; width: 100%; height: 75%; background: #000; z-index: 10; display: flex; align-items: center; justify-content: center; }
        #media-layer { width: 100%; height: 100%; display: none; background: #000; position: relative; }
        canvas, img, video, iframe { max-width: 100%; max-height: 100%; }
        #tv-log { position: absolute; bottom: 0; left: 0; width: 100%; height: 25%; background: rgba(0,0,0,0.9); border-top: 1px solid var(--text); color: var(--text); font-size: 13px; padding: 5px; overflow-y: auto; z-index: 100; pointer-events: none; }
        .log-item { margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .success { color: #0f0; } .error { color: #f44; } .info { color: #0cf; }
    </style>
</head>
<body>
    <div id="display-container">
        <div id="placeholder"><h1 style="color: #0cf; font-size: 30px;">READY FOR SIGNAL</h1></div>
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

        var MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
        var BEMFA_KEY = '3eb42d69d8b226abe22024d648975f8a';
        var TOPIC = BEMFA_KEY + '/PPT001';
        var CID = 'TV_' + Math.floor(Math.random()*100000);
        
        window.onload = function() {
            log('=== BUSINESS V6 START ===', 'info');
            var room = (new RegExp("[?&]room=([^&]+)").exec(location.search) || [])[1];
            if (room) {
                var h = 2166136261; var input = BEMFA_KEY + ":" + room;
                for (var i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
                var sig = (h >>> 0).toString(16); while(sig.length < 8) sig = '0' + sig;
                TOPIC += "_" + room + "_" + sig;
                log('ROOM: ' + room + ' SIG: ' + sig);
            }
            log('TOPIC: ' + TOPIC);

            var client = mqtt.connect(MQTT_URL, {
                clientId: CID, clean: true, connectTimeout: 5000,
                reconnectPeriod: 3000, protocolVersion: 4
            });

            client.on('connect', function() {
                log('NET: CONNECTED', 'success');
                client.subscribe(TOPIC);
            });

            client.on('message', function(t, m) {
                var msg = m.toString();
                log('RECV: ' + msg);
                try { 
                    var data = JSON.parse(msg);
                    // ??????????
                    if (data.pg !== undefined || data.u || data.url || data.pdfUrl) {
                        handleAction(data);
                    }
                } catch(e) { log('PARSE ERR: ' + e.message, 'error'); }
            });
        };

        function handleAction(data) {
            var layer = document.getElementById('media-layer');
            document.getElementById('placeholder').style.display = 'none';
            layer.style.display = 'block';
            
            var url = data.u || data.url || data.pdfUrl;
            var type = data.t || data.type || 'image';
            if (url && url.indexOf('http') !== 0) url = 'http://easyshow.beundredig.eu.org' + url;

            log('ACTION: ' + type + ' URL: ' + url, 'info');

            if (type === 'image' || (!type && url)) {
                layer.innerHTML = '<img src="' + url + '" style="width:100%; height:100%; object-fit:' + (data.fit || 'contain') + ';">';
            } else if (type === 'video') {
                layer.innerHTML = '<video src="' + url + '" autoplay controls style="width:100%; height:100%;"></video>';
            } else if (type === 'pdf') {
                layer.innerHTML = '<canvas id="pdf-canvas"></canvas>';
                renderPDF(url, data.pg || 1);
            } else if (type === 'iframe' || data.action === 'url') {
                layer.innerHTML = '<iframe src="' + url + '" style="width:100%; height:100%; border:none; background:#fff;"></iframe>';
            }
        }

        function renderPDF(url, pg) {
            pdfjsLib.getDocument(url).promise.then(function(pdf) {
                pdf.getPage(pg).then(function(page) {
                    var canvas = document.getElementById('pdf-canvas');
                    var viewport = page.getViewport({ scale: 1.5 });
                    var context = canvas.getContext('2d');
                    canvas.height = viewport.height; canvas.width = viewport.width;
                    page.render({ canvasContext: context, viewport: viewport });
                });
            });
        }
    </script>
</body>
</html>
EOF
