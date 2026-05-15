1.本地 videoDisplay 初始就有内容（或被自动恢复），--当前这个逻辑怎么来的？ 是原来下载到本地的吗？

不是“下载到本地文件”那种来源，更可能是这两类：
页面里的 videoDisplay 被代码设过 src（上次会话/状态恢复）
浏览器的会话恢复机制把媒体状态还原了（尤其同域同 URL 再打开）
在你这个项目里，videoDisplay 的内容主要来自脚本动态赋值：
loadPDF() 检测到视频 URL 后设置 pendingVideoUrl
playVideoInIframe() 里执行 videoEl.src = pendingVideoUrl; videoEl.play()
所以本质是“运行时注入的播放地址”