import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const files={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'};
createServer(async(req,res)=>{try{const path=files[new URL(req.url,'http://localhost').pathname];if(!path){res.writeHead(404);res.end('Not found');return;}const body=await readFile(new URL('./dist/'+path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});res.end(body);}catch{res.writeHead(500);res.end('Server error');}}).listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173'));
