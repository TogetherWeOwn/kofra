// Independent upstream oracle, not read from the encoder or its serialized body:
// https://github.com/kazuhikoarase/qrcode-generator/blob/master/LICENSE
export const QR_COPYRIGHT = "Copyright (c) 2009 Kazuhiko Arase";
export const QR_MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE.`;

// Allow wrapping and block/line-comment decoration, not missing words, changed
// punctuation, escaped string literals, or a fragment-only replacement notice.
export function normalizeQrNotice(text: string): string {
  return text
    .replace(/\/\*!?|\*\//g, " ")
    .replace(/^\s*(?:\*|\/\/) ?/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}
