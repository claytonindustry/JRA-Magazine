/* =====================================================================
   JRA Magazine — the upload door
   =====================================================================

   This Worker exists for one job: letting a signed-in editor put
   photographs into the R2 bucket. Nothing reads through it. Readers
   fetch images straight from the bucket's public address, which is what
   keeps egress free and this Worker's request count near zero.

   What it checks
   --------------
   Every upload carries the Firebase ID token the editor holds from
   signing in. The Worker asks Google whether that token is real, and
   then asks the magazine's own database whether that address is on the
   list of people who may edit.

   It used to compare the address against one name kept here, which was
   right while there was one shared account and wrong the moment there
   were several: a person taken off the magazine's list would have gone
   on uploading photographs into the bucket, because this door had never
   heard of the list. There is one answer to "may this person write",
   and it lives in the database with everything else.

   The lookup is made with the editor's own token, so this Worker holds
   no credentials of its own and can read no more than the person it is
   asking about.

   A person is filed under their address, with the dots written as
   commas because a database key may not hold one. index.html and
   database.rules.json spell it the same way; all three must agree.

   Setting it up (dashboard, no terminal)
   --------------------------------------
     Settings → Bindings → add an R2 bucket binding
         Variable name : BUCKET
         Bucket        : jra-magazine
     Settings → Variables → add
         FIREBASE_API_KEY : the apiKey from the FIREBASE block in index.html
         DB_URL           : the databaseURL from that same block
     and remove the old EDITOR_EMAIL, which is no longer read.
     then Deploy.

   The API key is not a secret — it identifies the Firebase project and
   is already public in the page. What guards this is the token, and
   behind it the database rules.
   ===================================================================== */

const MAX_BYTES  = 25 * 1024 * 1024;   // one photograph, generously
/* A printed edition is not a photograph. Some of them are three
   hundred megabytes, which is more than a Worker may be handed in one
   request on any plan — so they arrive in pieces and R2 is asked to
   put them back together. Every piece but the last must be at least
   five mebibytes; ten keeps the count low without making any one of
   them a long wait on a slow line. */
const PART_BYTES = 10 * 1024 * 1024;
const MAX_PART   = 64 * 1024 * 1024;   // a piece larger than this is a mistake
const MAX_FILES  = 12;                 // four sizes, with room to spare
const MAX_COPY   = 20;                 // fetches per call: the free plan allows 50 subrequests
const KEY_OK     = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/* The magazine keeps things in two places, and this door opens on no
   others. Without it a stripped leading slash turns "/etc/passwd" into
   the perfectly valid key "etc/passwd", and the bucket fills up with
   whatever a mistaken — or meddled-with — page happens to send. */
const PREFIXES = ['photos/', 'issues/'];

const TYPES = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
  gif:'image/gif',  avif:'image/avif', pdf:'application/pdf'
};

/* The bucket is public and the token is the guard, so any origin may ask.
   Locking this down would only break the editor the day it moves house. */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age':       '86400'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });

/* ---------------------------------------------------------------------
   Is this really an editor?

   Two questions, and both have to be yes: is the token real, and is the
   address on the magazine's list. Verification costs two calls, so the
   answer is kept for a minute against the token itself. Isolates come
   and go, which only means an occasional extra check.

   A minute is the whole cost of taking somebody's access away: that is
   the longest their uploads can go on working after they come off the
   list. It was five minutes when the only question was which account
   this was, and that answer could never change.
   --------------------------------------------------------------------- */
const seen = new Map();
const CACHE_MS = 60 * 1000;

/* Asked with the editor's own token, so this Worker needs no credentials
   and sees exactly what that person is allowed to see. */
const peopleKey = (email) => String(email || '').trim().toLowerCase().replace(/\./g, ',');

async function listed(email, token, env){
  const base = String(env.DB_URL || '').replace(/\/+$/, '');
  if(!base || !email) return false;
  let r;
  try{
    r = await fetch(base + '/people/' + encodeURIComponent(peopleKey(email))
                    + '.json?auth=' + encodeURIComponent(token));
  }catch(e){ return false; }
  if(!r.ok) return false;
  const rec = await r.json().catch(() => null);
  return !!(rec && typeof rec === 'object' && rec.role);
}

async function editorOf(token, env){
  if(!token) return null;

  const fresh = seen.get(token);
  if(fresh && fresh.until > Date.now()) return fresh.email;

  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
      encodeURIComponent(env.FIREBASE_API_KEY),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    }
  );
  if(!r.ok) return null;

  const data  = await r.json().catch(() => null);
  const user  = data && data.users && data.users[0];
  const email = user ? String(user.email || '').toLowerCase() : '';
  if(!email) return null;

  // the magazine's own list decides, not a name kept on this Worker
  if(!await listed(email, token, env)) return null;

  if(seen.size > 200) seen.clear();
  seen.set(token, { email, until: Date.now() + CACHE_MS });
  return email;
}

/* ---------------------------------------------------------------------
   A file too big to hand over in one go

   Three calls and a listing. The page says what it is about to send,
   sends it a piece at a time, and says when it is finished; R2 holds
   the pieces and joins them. Nothing is buffered here — a piece is
   passed straight through as it arrives — so the Worker's memory does
   not care whether the file is ten megabytes or three hundred.

   An upload that is begun and never finished costs nothing: R2 throws
   away the pieces of an incomplete one after seven days.
   --------------------------------------------------------------------- */
async function bigUpload(url, request, env){
  const what = url.pathname.slice('/big/'.length);

  if(what === 'start'){
    const body = await request.json().catch(() => ({}));
    const key = safeKey(body && body.key);
    if(!key) return json({ error: 'Bad key.' }, 400);
    const up = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: typeOf(key, body && body.type),
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });
    return json({ ok: true, key, uploadId: up.uploadId, partBytes: PART_BYTES });
  }

  if(what === 'part'){
    const key = safeKey(url.searchParams.get('key'));
    const uploadId = url.searchParams.get('uploadId') || '';
    const n = Number(url.searchParams.get('part') || 0);
    if(!key || !uploadId || !(n >= 1)) return json({ error: 'Bad piece.' }, 400);
    const len = Number(request.headers.get('content-length') || 0);
    if(len > MAX_PART) return json({ error: 'That piece is too large.' }, 413);
    if(!request.body) return json({ error: 'No piece in that request.' }, 400);
    const up = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await up.uploadPart(n, request.body);
    return json({ ok: true, partNumber: part.partNumber, etag: part.etag });
  }

  if(what === 'done'){
    const body = await request.json().catch(() => ({}));
    const key = safeKey(body && body.key);
    const uploadId = body && body.uploadId;
    const parts = Array.isArray(body && body.parts) ? body.parts : [];
    if(!key || !uploadId || !parts.length) return json({ error: 'Nothing to finish.' }, 400);
    const up = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const done = await up.complete(parts.map(p => ({
      partNumber: Number(p.partNumber), etag: String(p.etag) })));
    return json({ ok: true, key, size: done && done.size });
  }

  if(what === 'abort'){
    const body = await request.json().catch(() => ({}));
    const key = safeKey(body && body.key);
    const uploadId = body && body.uploadId;
    if(!key || !uploadId) return json({ error: 'Nothing to abandon.' }, 400);
    try{ await env.BUCKET.resumeMultipartUpload(key, uploadId).abort(); }
    catch(e){ /* seven days from now R2 does it anyway */ }
    return json({ ok: true });
  }

  return json({ error: 'Post to /big/start, /big/part, /big/done or /big/abort.' }, 404);
}

/* What is already in the bucket under a prefix, so a file put there by
   hand can be chosen from a list rather than typed out. */
async function listFiles(url, env){
  const prefix = String(url.searchParams.get('prefix') || '');
  if(!PREFIXES.some(p => prefix.startsWith(p)))
    return json({ error: 'Only photos/ and issues/ can be listed.' }, 400);
  const out = await env.BUCKET.list({ prefix, limit: 1000 });
  return json({ ok: true, files: (out.objects || []).map(o => ({
    key: o.key, size: o.size, at: o.uploaded })) });
}

/* A key arrives from the page, so it is checked rather than trusted. */
function safeKey(k){
  const key = String(k || '');
  if(!KEY_OK.test(key)) return null;
  if(key.includes('..') || key.includes('//')) return null;
  if(!PREFIXES.some(p => key.startsWith(p))) return null;
  return key;
}

function typeOf(key, given){
  const ext = key.split('.').pop().toLowerCase();
  if(TYPES[ext]) return TYPES[ext];
  if(given && /^[\w.+-]+\/[\w.+-]+$/.test(given)) return given;
  return 'application/octet-stream';
}

/* ---------------------------------------------------------------------
   Copying a photograph that is already on the web

   The older issues point at the WordPress uploads folder. Rather than
   pulling several hundred files down to someone's laptop and pushing
   them back up, the Worker fetches each one and writes it into the
   bucket — the bytes never leave Cloudflare's network.

   Only a signed-in editor can ask for this. If you want to narrow it
   further, set COPY_HOSTS to a comma-separated list of hostnames and
   nothing else will be fetched.
   --------------------------------------------------------------------- */
function sourceAllowed(url, env){
  let u;
  try{ u = new URL(url); }catch(e){ return false; }
  if(u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const allow = String(env.COPY_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if(!allow.length) return true;
  return allow.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}

async function copyOne(item, env){
  const key = safeKey(item && item.key);
  if(!key) return { name: item && item.key, why: 'bad key' };
  if(!sourceAllowed(item.url, env)) return { name: key, why: 'source not allowed' };
  let r;
  try{ r = await fetch(item.url, { cf: { cacheTtl: 0 } }); }
  catch(e){ return { name: key, why: 'could not reach it' }; }
  if(!r.ok) return { name: key, why: 'HTTP ' + r.status };

  const len = Number(r.headers.get('content-length') || 0);
  if(len > MAX_BYTES) return { name: key, why: 'too large' };

  const body = await r.arrayBuffer();
  if(body.byteLength > MAX_BYTES) return { name: key, why: 'too large' };
  if(!body.byteLength) return { name: key, why: 'empty' };

  try{
    await env.BUCKET.put(key, body, {
      httpMetadata: {
        contentType: typeOf(key, r.headers.get('content-type')),
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });
  }catch(e){ return { name: key, why: String(e && e.message || e) }; }
  return null;                                     // null means it landed
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);

    /* Something to look at when you open the address in a browser. */
    if(request.method === 'GET' && url.pathname === '/')
      return json({ ok: true, service: 'JRA Magazine uploads', bucket: !!env.BUCKET });

    const isUpload = request.method === 'POST' && url.pathname === '/upload';
    const isCopy   = request.method === 'POST' && url.pathname === '/copy';
    const isBig    = url.pathname.startsWith('/big/')
                     && (request.method === 'POST' || request.method === 'PUT');
    const isList   = request.method === 'GET' && url.pathname === '/files';
    if(!isUpload && !isCopy && !isBig && !isList)
      return json({ error: 'Post files to /upload, addresses to /copy, '
                         + 'a large file to /big/*, or ask /files what is here.' }, 404);

    if(!env.BUCKET)
      return json({ error: 'No bucket is bound to this Worker. Add an R2 binding named BUCKET.' }, 500);
    if(!env.FIREBASE_API_KEY)
      return json({ error: 'FIREBASE_API_KEY is not set on this Worker.' }, 500);
    /* Said plainly rather than turned away as "not an editor": without
       this the door cannot ask who is allowed, and an upload that fails
       because a variable is missing should not read like a wrong code. */
    if(!env.DB_URL)
      return json({ error: 'DB_URL is not set on this Worker, so who may edit cannot be checked.' }, 500);

    const auth  = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const email = await editorOf(token, env);
    if(!email) return json({ error: 'Not signed in as an editor.' }, 401);

    /* the same check guards these as guards a photograph */
    if(isBig)  return bigUpload(url, request, env);
    if(isList) return listFiles(url, env);

    /* ---- copying from somewhere else on the web ---- */
    if(isCopy){
      let body;
      try{ body = await request.json(); }
      catch(e){ return json({ error: 'Send JSON: { items: [{ url, key }] }.' }, 400); }
      const items = Array.isArray(body && body.items) ? body.items : [];
      if(!items.length)      return json({ error: 'No addresses in that request.' }, 400);
      if(items.length > MAX_COPY) return json({ error: `Too many at once (max ${MAX_COPY}).` }, 400);

      const results = await Promise.all(items.map(it => copyOne(it, env)));
      const failed = results.filter(Boolean);
      const stored = items.filter((_, i) => !results[i]).map(it => safeKey(it.key));
      return json({ ok: failed.length === 0, stored, failed }, failed.length ? 207 : 200);
    }

    let form;
    try{ form = await request.formData(); }
    catch(e){ return json({ error: 'Send the files as multipart/form-data.' }, 400); }

    /* Each part is named for the key it should be stored under, so one
       photograph's four sizes travel together under one check. */
    const parts = [...form.entries()].filter(([, v]) => v && typeof v === 'object' && 'arrayBuffer' in v);
    if(!parts.length)  return json({ error: 'No files in that upload.' }, 400);
    if(parts.length > MAX_FILES) return json({ error: `Too many files at once (max ${MAX_FILES}).` }, 400);

    const stored = [], failed = [];
    for(const [name, file] of parts){
      const key = safeKey(name);
      if(!key){ failed.push({ name, why: 'bad key' }); continue; }
      if(file.size > MAX_BYTES){ failed.push({ name: key, why: 'too large' }); continue; }
      try{
        await env.BUCKET.put(key, file.stream(), {
          httpMetadata: {
            contentType: typeOf(key, file.type),
            /* every name carries its own id, so a file never changes
               under a reader once it is written */
            cacheControl: 'public, max-age=31536000, immutable'
          }
        });
        stored.push(key);
      }catch(e){
        failed.push({ name: key, why: String(e && e.message || e) });
      }
    }

    return json({ ok: failed.length === 0, stored, failed }, failed.length ? 207 : 200);
  }
};
