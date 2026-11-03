import crypto from 'node:crypto';
import multer from 'multer';

const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:8}}).single('document');
export const evidenceUpload = (req,res,next) => upload(req,res,error => {
  if(error) return res.status(400).json({error:error.code==='LIMIT_FILE_SIZE' ? 'La constancia supera 10 MB.' : 'Adjunta una sola constancia PDF, JPG, PNG o WEBP.'});
  next();
});

export function checkBankEvidence(file) {
  const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
  if(!file?.buffer?.length) invalid('Adjunta la constancia bancaria del movimiento.');
  const b=file.buffer;
  const signatures={
    'application/pdf':b.subarray(0,5).toString()==='%PDF-',
    'image/jpeg':b[0]===255 && b[1]===216 && b[2]===255,
    'image/png':b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/webp':b.subarray(0,4).toString()==='RIFF' && b.subarray(8,12).toString()==='WEBP',
  };
  if(!signatures[file.mimetype]) invalid('El contenido de la constancia debe ser PDF, JPG, PNG o WEBP.');
  return crypto.createHash('sha256').update(b).digest('hex');
}

export async function attachBankEvidence(db, storage, movementId, file, actorId, savedFiles) {
  const hash=checkBankEvidence(file);
  const existing=await db.query('SELECT id FROM movement_files WHERE movement_id=$1 AND sha256=$2',[movementId,hash]);
  if(existing.rows.length) throw Object.assign(new Error('Esta constancia ya está adjunta al movimiento.'),{status:409});
  const saved=await storage.saveEvidence(file,'constancias');
  savedFiles.push(saved);
  await db.query(`INSERT INTO movement_files(movement_id,file_name,file_mime,file_storage,file_key,file_size,sha256,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[movementId,file.originalname.slice(0,255),file.mimetype,saved.storage,saved.key,file.buffer.length,hash,actorId]);
}
