window.XMLHttpRequest = class {
  constructor() {
    this.readyState  = 0;
    this.status      = 0;
    this.response    = null;
    this.onload      = null;
    this.onerror     = null;
    this._url        = '';
  }
  open(_m, url) { this._url = url; }
  setRequestHeader() {}
  abort() {}
  send() {
    const filename = this._url.split('/').pop();
    const buf = window._kuromojiDictCache?.[filename];
    Promise.resolve().then(() => {
      if (buf) {
        this.readyState = 4; this.status = 200; this.response = buf;
        if (this.onload) this.onload.call(this, { target: this });
      } else {
        this.readyState = 4; this.status = 0;
        if (this.onerror) this.onerror.call(this, new Error(`Not pre-loaded: ${filename}`));
      }
    });
  }
};
