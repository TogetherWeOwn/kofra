import { URL_ATTRS, type PathRewrite } from "./path-rewrite";

/**
 * Runtime half of path-mode URL rewriting, for pages without Referer context.
 *
 * In path mode a site lives under a prefix (/s/<slug>/ or /<slug>/). The server
 * rewrites root-relative URLs in HTML and CSS (./path-rewrite), and resolves
 * other root-relative requests through the Referer. A sandboxed page has an
 * opaque origin, and browsers send no Referer at all from it, whatever the
 * Referrer-Policy (measured: Chrome 151 sends none for strict-origin-when-cross-origin,
 * no-referrer-when-downgrade, unsafe-url, same-origin and origin-when-cross-origin).
 * So a URL built in JavaScript, such as fetch("/" + "data.json"), would escape
 * the site and 404.
 *
 * This small script is injected into sandboxed and private-preview path-mode HTML
 * pages, before the page's first script. Previews suppress Referer even without a
 * sandbox. It applies the same rule as the server-side rewriter at
 * run time: a root-relative URL ("/data.json") gets the site prefix; absolute
 * URLs, protocol-relative URLs, relative URLs and paths already under the prefix
 * (or under a `keep` prefix) are left alone. It covers fetch(), XMLHttpRequest,
 * new Request(), EventSource, navigator.sendBeacon(), window.open(), the URL properties and
 * setAttribute() of the same elements the server rewrites, and elements added
 * later (innerHTML), which are corrected as they are inserted.
 *
 * Not covered (path mode limits; subdomain mode has none of them): import
 * specifiers ("/x.js" in import statements and import()), CSS set from JS,
 * location.href = "/x" and history.pushState("/x"). Use relative URLs there.
 */

/** Bumped whenever the script changes, so cached pages revalidate (it is part of the ETag). */
export const PATH_SHIM_VERSION = 1;

/** Element URL properties wrapped at run time: [constructor, property, attribute]. */
const PROPS: ReadonlyArray<readonly [string, string, string]> = [
  ["HTMLAnchorElement", "href", "href"],
  ["HTMLAreaElement", "href", "href"],
  ["HTMLLinkElement", "href", "href"],
  ["HTMLScriptElement", "src", "src"],
  ["HTMLImageElement", "src", "src"],
  ["HTMLImageElement", "srcset", "srcset"],
  ["HTMLSourceElement", "src", "src"],
  ["HTMLSourceElement", "srcset", "srcset"],
  ["HTMLMediaElement", "src", "src"],
  ["HTMLVideoElement", "poster", "poster"],
  ["HTMLTrackElement", "src", "src"],
  ["HTMLIFrameElement", "src", "src"],
  ["HTMLEmbedElement", "src", "src"],
  ["HTMLObjectElement", "data", "data"],
  ["HTMLFormElement", "action", "action"],
  ["HTMLButtonElement", "formAction", "formaction"],
  ["HTMLInputElement", "src", "src"],
  ["HTMLInputElement", "formAction", "formaction"],
];

/** tag -> URL attributes, from the table the server-side rewriter uses, so both halves agree. */
function attributeTable(): Record<string, string[]> {
  const t: Record<string, string[]> = {};
  for (const [selector, attr] of URL_ATTRS) {
    const tag = selector.slice(0, selector.indexOf("["));
    const list = (t[tag] ??= []);
    if (!list.includes(attr)) list.push(attr);
  }
  return t;
}

/*
 * The script. Plain ES2015, no dependencies. Arguments:
 * B site prefix ("/s/slug/"), K kept prefixes, T tag -> attributes, P properties, S selector.
 * Every patch is wrapped so a browser without one API still gets the others.
 */
const SOURCE = `(function(B,K,T,P,S){"use strict";
var W=window,R=B.slice(0,-1);
function fix(u){if(typeof u!=="string")return u;var s=u.replace(/^[\\s\\u0000-\\u001f]+/,"");
if(s.charAt(0)!=="/"||s.charAt(1)==="/"||s.charAt(1)==="\\\\")return u;
if(s.indexOf(B)===0||s===R||s.indexOf(R+"?")===0||s.indexOf(R+"#")===0)return u;
for(var i=0;i<K.length;i++)if(s.indexOf(K[i])===0)return u;
return B+s.slice(1);}
function fixSet(v){return String(v).split(",").map(function(c){var m=/^(\\s*)(\\S+)([\\s\\S]*)$/.exec(c);return m?m[1]+fix(m[2])+m[3]:c;}).join(",");}
function fa(a,v){return a==="srcset"?fixSet(v):fix(v);}
function wrap(o,k,f){try{if(o&&typeof o[k]==="function")o[k]=f(o[k]);}catch(e){}}
wrap(W,"fetch",function(g){return function(i,n){return g.call(W,fix(i),n);};});
try{if(W.Request){var Q=W.Request;W.Request=class Request extends Q{constructor(i,n){super(fix(i),n);}};}}catch(e){}
wrap(W.XMLHttpRequest&&W.XMLHttpRequest.prototype,"open",function(g){return function(){var a=[].slice.call(arguments);if(a.length>1)a[1]=fix(a[1]);return g.apply(this,a);};});
wrap(W.navigator,"sendBeacon",function(g){return function(u,d){return g.call(W.navigator,fix(u),d);};});
wrap(W,"open",function(g){return function(){var a=[].slice.call(arguments);if(a.length)a[0]=fix(a[0]);return g.apply(W,a);};});
try{if(W.EventSource){var E=W.EventSource;W.EventSource=class EventSource extends E{constructor(u,o){super(fix(u),o);}};}}catch(e){}
P.forEach(function(x){try{var C=W[x[0]],d=C&&Object.getOwnPropertyDescriptor(C.prototype,x[1]);if(!d||!d.set||!d.configurable)return;
Object.defineProperty(C.prototype,x[1],{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,typeof v==="string"?fa(x[2],v):v);}});}catch(e){}});
function want(el,a){var t=T[String(el&&el.localName||"").toLowerCase()];return!!t&&t.indexOf(a)>=0;}
var EP=W.Element&&W.Element.prototype,SA=EP&&EP.setAttribute;
wrap(EP,"setAttribute",function(g){return function(n,v){try{var a=String(n).toLowerCase();if(want(this,a))v=fa(a,String(v));}catch(e){}return g.call(this,n,v);};});
wrap(EP,"setAttributeNS",function(g){return function(ns,n,v){try{var a=String(n).toLowerCase().replace(/^xlink:/,"");if(want(this,a))v=fa(a,String(v));}catch(e){}return g.call(this,ns,n,v);};});
function tree(r){if(!r||r.nodeType!==1||!SA)return;var l=[r];try{l=l.concat([].slice.call(r.querySelectorAll(S)));}catch(e){}
l.forEach(function(el){(T[String(el.localName||"").toLowerCase()]||[]).forEach(function(a){var v=el.getAttribute(a);if(v===null)return;var f=fa(a,v);if(f!==v)SA.call(el,a,f);});});}
try{new MutationObserver(function(ms){ms.forEach(function(m){[].forEach.call(m.addedNodes,tree);});}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
})`;

/** JSON that is safe inside an inline <script> ("<" never appears literally). */
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The inline <script> element for a site prefix. */
export function pathShimScript(rw: PathRewrite): string {
  const table = attributeTable();
  const selector = URL_ATTRS.map(([sel]) => sel).join(",");
  const args = [rw.base, rw.keep, table, PROPS, selector].map(inlineJson).join(",");
  return `<script data-dropway="path-shim">${SOURCE}(${args});</script>`;
}
