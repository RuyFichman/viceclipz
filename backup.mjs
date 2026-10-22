import {mkdir,readdir,readFile,writeFile,copyFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function files(root,relative=''){const result=[];for(const item of await readdir(path.join(root,relative),{withFileTypes:true})){if(item.name==='temp'||item.name==='server.lock'||item.name==='backup-manifest.json')continue;if(item.isSymbolicLink())throw Error('Links simbólicos não são permitidos no backup.');const name=path.join(relative,item.name);if(item.isDirectory())result.push(...await files(root,name));else if(item.isFile())result.push(name);}return result;}
export async function backup(source,destination,restore=false){
 source=path.resolve(source);destination=path.resolve(destination);
 if(destination===source||destination.startsWith(source+path.sep)||source.startsWith(destination+path.sep))throw Error('Origem e destino devem ser diretórios separados.');
 if(await exists(destination))throw Error('O destino deve ser novo; nenhum arquivo será sobrescrito.');
 if(await exists(path.join(source,'server.lock')))throw Error('Pare o servidor antes do backup.');
 const names=await files(source),manifest={version:1,created:new Date().toISOString(),files:{}};
 if(restore){const saved=JSON.parse(await readFile(path.join(source,'backup-manifest.json'),'utf8'));if(saved.version!==1||!saved.files)throw Error('Manifesto inválido.');if(JSON.stringify(Object.keys(saved.files).sort())!==JSON.stringify([...names].sort()))throw Error('A lista de arquivos do backup foi alterada.');for(const name of names)if(await digest(path.join(source,name))!==saved.files[name])throw Error('Checksum inválido: '+name);}
 const database=new DatabaseSync(path.join(source,'viceclipz.sqlite'),{readOnly:true});try{if(database.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Integridade do banco inválida.');}finally{database.close();}
 await mkdir(destination,{recursive:false});
 for(const name of names){await mkdir(path.dirname(path.join(destination,name)),{recursive:true});await copyFile(path.join(source,name),path.join(destination,name));manifest.files[name]=await digest(path.join(destination,name));}
 if(!restore)await writeFile(path.join(destination,'backup-manifest.json'),JSON.stringify(manifest,null,2));
 return {files:names.length,destination};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,source,destination]=process.argv.slice(2);if(!['create','restore'].includes(mode)||!source||!destination)throw Error('Uso: node backup.mjs create|restore ORIGEM DESTINO_NOVO');
 console.log(await backup(source,destination,mode==='restore'));
}
