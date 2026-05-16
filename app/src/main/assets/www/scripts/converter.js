const http = require('http');
const https = require('https');
const url = require('url');

const CONFIG = {
    PORT: 3000,
    KK_URL: "http://127.0.0.1:8012",
    WEBDAV: {
        URL: "https://ajiro.infini-cloud.net/dav/",
        USER: "chf5762",
        PASS: "piNdCJ4EPiw5Wtgn"
    }
};

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                console.log(`[Queue] Task: ${data.filename}`);
                res.writeHead(200); res.end(JSON.stringify({ status: 'queued' }));
                processConversion(data);
            } catch (e) { res.writeHead(400); res.end(); }
        });
    }
});

async function processConversion(data) {
    const { filename, path, publicUrl } = data;
    const shadowFilename = `.${filename}.pdf`;
    const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    const targetWebdavPath = (dir ? dir + '/' : '') + shadowFilename;

    console.log(`[Original Plan] Triggering conversion for: ${filename}`);

    try {
        const b64Url = Buffer.from(publicUrl).toString('base64');
        // 关键：告诉 KK 这是 officePreviewType=pdf
        const previewUrl = `${CONFIG.KK_URL}/onlinePreview?url=${encodeURIComponent(b64Url)}&fullfilename=${encodeURIComponent(filename)}&officePreviewType=pdf`;
        const pdfDlUrl = `${CONFIG.KK_URL}/getCorsFile?urlPath=${encodeURIComponent(b64Url)}`;

        // 1. 触发转换指令
        await fetchText(previewUrl);

        // 2. 轮询结果 (直接找 %PDF 头)
        let pdfBuffer = null;
        for (let i = 1; i <= 20; i++) {
            const result = await fetchBufferEx(pdfDlUrl);
            const buf = result.buffer;

            if (buf.length > 1000 && buf.toString('utf8', 0, 4) === '%PDF') {
                console.log(`[Success] Captured PDF! Size: ${buf.length}`);
                pdfBuffer = buf;
                break;
            } else {
                const hint = buf.length > 0 ? buf.slice(0, 4).toString() : "empty";
                console.log(`[Wait ${i}/20] Still returning: ${hint}... (Need %PDF)`);
            }
            await new Promise(r => setTimeout(r, 4000));
        }

        if (!pdfBuffer) throw new Error("Conversion failed (Timeout)");

        // 3. 存回网盘
        await uploadToWebdav(targetWebdavPath, pdfBuffer);
        console.log(`[Done] Saved to: ${targetWebdavPath}`);

    } catch (err) {
        console.error(`[Error] ${err.message}`);
    }
}

// 辅助函数保持最简
function fetchBufferEx(u) {
    return new Promise((r) => {
        http.get(u, s => {
            const c = [];
            s.on('data', x => c.push(x));
            s.on('end', () => r({ status: s.statusCode, buffer: Buffer.concat(c) }));
        }).on('error', e => r({ status: 'Error', buffer: Buffer.from(e.message) }));
    });
}
function fetchText(u) { return new Promise((r, j) => { http.get(u, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => r(d)); }).on('error', j); }); }
function uploadToWebdav(p, b) {
    return new Promise((r, j) => {
        const uo = url.parse(CONFIG.WEBDAV.URL + p.replace(/^\//, ''));
        const options = {
            hostname: uo.hostname, path: uo.path, method: 'PUT',
            headers: {
                'Content-Type': 'application/pdf', 'Content-Length': b.length,
                'Authorization': 'Basic ' + Buffer.from(CONFIG.WEBDAV.USER + ':' + CONFIG.WEBDAV.PASS).toString('base64'), 'Overwrite': 'T'
            }
        };
        const req = https.request(options, s => { if (s.statusCode < 400) r(); else j(new Error(s.statusCode)); });
        req.on('error', j); req.write(b); req.end();
    });
}

server.listen(CONFIG.PORT, () => console.log(`Converter Listening on ${CONFIG.PORT}`));