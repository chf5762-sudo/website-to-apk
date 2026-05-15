Fault Summary - 乱码问题与终极解决方案
最安全方案是把“展示内容”改成二进制安全传输，彻底绕开终端和本地代码页。

核心改造点：
1. 统一协议：只传 base64，不传原始中文字符串。API 增加 content_b64 / text_b64 字段。
2. Worker 处理：收到后用 UTF-8 解码再写入 state。
3. CLI 限制：禁止直接 --text 中文，强制使用 --text-file / --content-file（CLI 读取后自动转 base64）。
4. 渲染端：页面直接渲染已解码的字符串，不做猜编码或客户端纠错逻辑。
5. 完整性：带 sha256 校验，防止传输中内容损坏。
6. (可选) URL 引用模式：大内容先上传对象存储，API 只推送 content_url。
