# 1. ??????? MQTT ? (5.3.4)
curl -L "https://unpkg.com/mqtt@5.3.4/dist/mqtt.min.js" -o "app/src/main/assets/www/scripts/mqtt.min.js"

# 2. ???? HTML
cat <<EOF > app/src/main/assets/www/index_v3s.html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>GitBash v5.3.4 Debug</title>
    <script src="scripts/mqtt.min.js"></script>
    <style>
        body { background: #000; color: #fff; margin: 0; padding: 0; overflow: hidden; }
        #log-panel {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.9); color: #0f0; font-size: 16px; padding: 10px;
            overflow-y: auto; border: 2px solid #0f0;
        }
    </style>
</head>
<body>
    <div id="log-panel"></div>
    <script>
        function tvLog(msg, type) {
            var p = document.getElementById('log-panel');
            var d = document.createElement('div');
            d.style.color = (type === 'error') ? 'red' : (type === 'success' ? '#0f0' : '#fff');
            d.innerHTML = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            p.appendChild(d);
            p.scrollTop = p.scrollHeight;
        }
        var MQTT_URL = 'wss://broker.emqx.io:8084/mqtt'; 
        var TOPIC = '3eb42d69d8b226abe22024d648975f8a/PPT001';
        var CLIENT_ID = 'TV_' + Math.floor(Math.random()*1000000);
        window.onload = function() {
            tvLog('=== VERSION 5.3.4 START (GITBASH) ===');
            if (typeof mqtt === 'undefined') {
                tvLog('ERROR: mqtt not loaded!', 'error'); return;
            }
            tvLog('Connecting to: ' + MQTT_URL);
            try {
                var client = mqtt.connect(MQTT_URL, {
                    clientId: CLIENT_ID, clean: true,
                    connectTimeout: 4000, reconnectPeriod: 3000,
                    protocolVersion: 4
                });
                client.on('connect', function() {
                    tvLog('SUCCESS: CONNECTED!', 'success');
                    client.subscribe(TOPIC);
                });
                client.on('message', function(t, m) {
                    tvLog('MSG: ' + m.toString());
                });
                client.on('error', function(e) {
                    tvLog('ERR: ' + e.message, 'error');
                });
                client.on('offline', function() {
                    tvLog('STATUS: Offline', 'error');
                });
            } catch (e) {
                tvLog('CRASH: ' + e.message, 'error');
            }
        };
    </script>
</body>
</html>
EOF
