/** Inline, report-only print rules; appended after the screen styles. No disclosure or pane display overrides. */
export const REPORT_PRINT_CSS = `
body>.dw-print-title{display:none}
@media print{
:root{color-scheme:light;--muted:#000;--accent:#000;--paper:#fff;--paper-2:#fff;--ink:#000;--ink-2:#000;--rule:#aaa;--rule-soft:#aaa}
body{background:#fff;color:#000;font-size:12pt}
body *{color:#000!important;background:transparent!important;box-shadow:none!important;text-shadow:none!important}
body>header.k-vbar,body>.k-skip,body>footer,.dw-codewrap>.dw-codehead,.dw-json>.dw-jtabs,.k-doc :is(h1,h2,h3,h4,h5,h6)>:is(.md-anchor,.anchor-link),body>a[href$="/__dropway/report"],button{display:none!important}
body>.dw-print-title{display:block;margin:0 0 1rem;padding:0 0 .4rem;border-bottom:1px solid var(--rule);font:600 10pt/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
.k-doc,.dw-nb,.dw-json,.dw-csv{max-width:none;margin:0;padding:0;overflow-wrap:anywhere}
.dw-src,.dw-csvwrap,.dw-jtree,pre{height:auto!important;max-height:none!important;max-width:100%;overflow:visible!important}
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
.k-doc table,.dw-nb table,.dw-csvwrap table{display:table;width:100%;min-width:0;max-width:100%;table-layout:fixed;border-collapse:collapse;overflow:visible}
.k-doc th,.k-doc td,.dw-nb th,.dw-nb td,.dw-csvwrap th,.dw-csvwrap td{position:static;max-width:none;padding:.25em;white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}
.dw-csvwrap .rn{width:2.8em}
thead{display:table-header-group}
tr{break-inside:avoid}
h1,h2,h3,h4,h5,h6,summary{break-after:avoid}
img,video{max-width:100%;height:auto}
.k-notebar{max-width:none;break-inside:avoid}
}
`;
