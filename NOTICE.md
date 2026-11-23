# Notice

The core of this plugin is ported from [dsh-world](https://github.com/chenkezhen480/dsh-world) 0.8, `src/ecosystem/computer/` (MIT, Copyright (c) 2026 ckz).

Within it, these files were ported and rewritten from `sidecar.js` and `read.js` of [dsh-inner-browser-use](https://www.npmjs.com/package/dsh-inner-browser-use) 0.47.28:

- `src/browser/edge.ts`: finding and launching the browser, its launch arguments, reading `DevToolsActivePort`.
- `src/browser/cdp.ts`: the minimal CDP session.
- `src/browser/pageLib.ts`: the in-page element registry, roles and names, visibility rules.

（中文：本插件核心代码移植自 dsh-world 0.8；上面三个文件又移植并改写自 dsh-inner-browser-use 0.47.28，原许可如下。）

The thought/step overlay (`scripts/windows-takeover.ps1`, `scripts/windows-takeover.cs`, `scripts/native-loader.ps1`, `scripts/native/`, `src/desktop/overlay.ts`, `src/desktop/overlay-strings.ts`) is ported from [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3 (MIT). Its license:

MIT License

Copyright (c) 2026 Yu-tao-Li
Copyright (c) 2026 cgissing

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

（中文：右上角的思考/步骤浮窗移植自 dsh-computer-use-win 0.6.3，原许可如上。）

Its license:

MIT License

Copyright (c) 2026 regrevia

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
