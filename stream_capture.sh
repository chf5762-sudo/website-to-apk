cat <<EOF > app/src/main/assets/www/index_v3s.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>XiaoMi Box Stream Capture</title>
    <script src="scripts/mqtt.min.js"></script>
    <script src="https://cdn.bootcdn.net/ajax/libs/pdf.js/2.10.377/pdf.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; color: #fff; font-family: monospace; overflow: hidden; width: 100vw; height: 100vh; }
        #display-container { position: absolute; top: 0; left: 0; width: 100%; height: 60%; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #333; }
        #media-layer { width: 100%; height: 100%; display: none; }
        canvas, img, video { max-width: 100%; max-height: 100%; }
        #tv-log { position: absolute; bottom: 0; left: 0; width: 100%; height: 40%; background: #000; color: #0f0; font-size: 12px; padding: 5px; overflow-y: auto; border-top: 2px solid #0f0; }
        .log-item { border-bottom: 1px dashed #222; padding: 2px 0; }
        .msg-raw { color: #aaa; font-size: 10px; display: block; }
        .highlight { color: #ff0; }
    </style>
</head>
<body>
    <div id="display-container">
        <div id="placeholder"><h2>STREAM CAPTURE MODE</h2><p id="room-status"></p></div>
        <div id="media-layer"></div>
    </div>
    <div id="tv-log"></div>

    <script>
        function log(node, msg, raw) {
            var p = document.getElementById('tv-log');
            var d = document.createElement('div');
            d.className = 'log-item';
            var time = new Date().toLocaleTimeString();
            d.innerHTML = '<b>[' + time + '] [' + node + ']</b> ' + msg;
            if (raw) {
                var s = document.createElement('span');
                s.className = 'msg-raw';
                s.innerText = 'RAW: ' + raw;
                d.appendChild(s);
            }
            p.appendChild(d);
            p.scrollTop = p.scrollHeight;
        }

        var BEMFA_KEY = '3eb42d69d8b226abe22024d648975f8a';
        var MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
        
        window.onload = function() {
            var room = (new RegExp("[?&]room=([^&]+)").exec(location.search) || [])[1] || "admin";
            document.getElementById('room-status').innerText = 'Room: ' + room;
            
            // ????
            var h = 2166136261; var input = BEMFA_KEY + ":" + room;
            for (var i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
            var sig = (h >>> 0).toString(16); while(sig.length < 8) sig = '0' + sig;
            
            var finalTopic = BEMFA_KEY + '/PPT001_' + room + '_' + sig;
            log('CONFIG', 'Room: ' + room + ' | Sig: ' + sig);
            log('TOPIC', finalTopic);

            var client = mqtt.connect(MQTT_URL, { clientId: 'TV_' + Math.random(), protocolVersion: 4 });
            client.on('connect', function() {
                log('NET', 'Connected to Broker', null);
                client.subscribe(finalTopic);
                log('SUB', 'Subscribed to: ' + finalTopic);
            });

            client.on('message', function(t, m) {
                var raw = m.toString();
                log('RECV', 'Message Received', raw);
                try {
                    var data = JSON.parse(raw);
                    // ????????????
                    if(data.u || data.pg) log('PROCESS', '<span class="highlight">DETECTED ACTION: ' + (data.t || 'page') + '</span>');
                    handleAction(data);
                } catch(e) {}
            });
        };

        function handleAction(data) {
            var url = data.u || data.url || data.pdfUrl;
            if (!url) return;
            if (url.indexOf('http') !== 0) url = 'http://easyshow.beundredig.eu.org' + url;

            var layer = document.getElementById('media-layer');
            document.getElementById('placeholder').style.display = 'none';
            layer.style.display = 'block';
            layer.innerHTML = '';

            var type = data.t || data.type || (url.indexOf('.pdf') > 0 ? 'pdf' : 'image');
            
            if (type === 'image') {
                layer.innerHTML = '<img src="' + url + '" style="width:100%;">';
            } else if (type === 'video') {
                layer.innerHTML = '<video src="' + url + '" autoplay controls style="width:100%;"></video>';
            } else if (type === 'pdf') {
                layer.innerHTML = '<canvas id="pdf-canvas"></canvas>';
                pdfjsLib.getDocument(url).promise.then(function(pdf) {
                    pdf.getPage(data.pg || 1).then(function(page) {
                        var canvas = document.getElementById('pdf-canvas');
                        var viewport = page.getViewport({ scale: 1.0 });
                        var context = canvas.getContext('2d');
                        canvas.height = viewport.height; canvas.width = viewport.width;
                        page.render({ canvasContext: context, viewport: viewport });
                    });
                });
            }
        }
    </script>
</body>
</html>
EOF
