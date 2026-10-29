/** Inline, report-only print rules; appended after the screen styles. No disclosure or pane display overrides. */
export const REPORT_PRINT_CSS = `
body>.dw-print-title{display:none}
@media print{
:root{color-scheme:light;--bg:#fff;--fg:#000;--muted:#000;--line:#aaa;--card:#fff;--accent:#000;--code:#fff}
body{background:#fff;color:#000;font-size:12pt}
body *{color:#000!important;background:transparent!important;box-shadow:none!important;text-shadow:none!important}
body>header.dw-vbar,main.dw-codewrap>.dw-codehead,main.dw-json>.dw-jtabs,.dw-md :is(h1,h2,h3,h4,h5,h6)>.dw-anchor,body>a[href$="/__dropway/report"],button{display:none!important}
body>.dw-print-title{display:block;margin:0 0 1rem;padding:0 0 .4rem;border-bottom:1px solid var(--line);font:600 10pt/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
.dw-md,.dw-nb,.dw-json,.dw-csv{max-width:none;margin:0;padding:0;overflow-wrap:anywhere}
.dw-src,.dw-table,.dw-jtree,pre{height:auto!important;max-height:none!important;max-width:100%;overflow:visible!important}
.dw-src{margin:0;border:0}
pre,code,.dw-ln>.c{white-space:pre-wrap!important;overflow-wrap:anywhere}
pre{font-size:10pt!important}
.dw-lines{width:100%;min-width:0;table-layout:fixed}
.dw-ln>a{width:3.2em;min-width:0;padding:0 .5em 0 0;opacity:1}
.dw-ln>.c{padding:0 .5em}
.dw-jtree li{white-space:normal;overflow-wrap:anywhere}
.dw-jtree ul{padding-left:.8rem}
.dw-cell{display:block}
.dw-prompt{text-align:left;padding:0}
.dw-cell>div,.dw-mdcell,.dw-out{min-width:0}
.dw-md table,.dw-nb table,.dw-table table{display:table;width:100%;min-width:0;max-width:100%;table-layout:fixed;border-collapse:collapse;overflow:visible}
.dw-md th,.dw-md td,.dw-nb th,.dw-nb td,.dw-table th,.dw-table td{position:static;max-width:none;padding:.25em;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
.dw-table .rn{width:2.8em}
thead{display:table-header-group}
tr{break-inside:avoid}
h1,h2,h3,h4,h5,h6,summary{break-after:avoid}
img,video{max-width:100%;height:auto}
.dw-note{max-width:none;break-inside:avoid}
}
`;
