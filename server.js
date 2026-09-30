import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { del } from '@vercel/blob';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanText, validSlug, youtubeId } from './lib.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');
const demoMode = process.env.DEMO_MODE === 'true';
const production = process.env.NODE_ENV === 'production';
if (!process.env.SESSION_SECRET || !process.env.ADMIN_PASSWORD) throw new Error('Set SESSION_SECRET and ADMIN_PASSWORD in .env');
if (!demoMode && !process.env.MONGODB_URI) throw new Error('Set MONGODB_URI, or use DEMO_MODE=true for a temporary preview.');
if (!demoMode) await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
await mkdir(uploadsDir, {recursive:true});
const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
const Invite = mongoose.model('Invite', new mongoose.Schema({
  name: String, slug: {type:String, unique:true, index:true}, message:String, songUrl:String, songId:String,
  description:{type:String,default:''}, profilePhoto:{type:String,default:''}, photos:[String], status:{type:String,default:'pending'}, response:mongoose.Schema.Types.Mixed,
  responseHistory:[mongoose.Schema.Types.Mixed], views:{type:Number,default:0}, lastViewedAt:Date,
}, {timestamps:true}));
const Settings = mongoose.model('Settings', new mongoose.Schema({ key:{type:String,unique:true}, data:mongoose.Schema.Types.Mixed }));
const photoBucket=demoMode?null:new mongoose.mongo.GridFSBucket(mongoose.connection.db,{bucketName:'partyPhotos'});
const uploadChunkSize=3*1024*1024;
const photoUploadSchema=new mongoose.Schema({slug:{type:String,required:true},field:{type:String,required:true},sessionId:{type:String,required:true},filename:{type:String,required:true},contentType:String,size:{type:Number,required:true},chunkCount:{type:Number,required:true},expiresAt:{type:Date,default:()=>new Date(Date.now()+24*60*60*1000)}});
photoUploadSchema.index({expiresAt:1},{expireAfterSeconds:0});
const PhotoUpload=mongoose.model('PhotoUpload',photoUploadSchema);
const photoUploadPartSchema=new mongoose.Schema({uploadId:{type:mongoose.Schema.Types.ObjectId,required:true},index:{type:Number,required:true},data:{type:Buffer,required:true},expiresAt:{type:Date,default:()=>new Date(Date.now()+24*60*60*1000)}});
photoUploadPartSchema.index({uploadId:1,index:1},{unique:true});
photoUploadPartSchema.index({expiresAt:1},{expireAfterSeconds:0});
const PhotoUploadPart=mongoose.model('PhotoUploadPart',photoUploadPartSchema);
if(!demoMode)await Promise.all([PhotoUpload.createIndexes(),PhotoUploadPart.createIndexes()]);
const defaults = { hosts:'Pravith & Abhishek', title:'Two birthdays. One unforgettable night.', date:'', time:'', timezone:'Asia/Kolkata', venue:'The spot is being picked', address:'Location coming soon — we’ll keep you posted.', mapsUrl:'', dressCode:'Come as your favourite self', message:'Good people. Great music. A night that wouldn’t be the same without you.', thankYou:'You just made our birthday better. Seriously. We can’t wait to laugh too loudly, take too many photos, and make another memory with you.', emotionalMessage:'What ya… you’re really going to miss this? We saved a little space for you in every plan. It won’t quite be the same without you. If you can make it, you know where to find us. And if you can’t, we’ll save you a slice.' };
let memorySettings = {...defaults};
const memory = new Map();
const getSettings = async()=> demoMode ? memorySettings : {...defaults,...(await Settings.findOne({key:'party'}).lean())?.data};
const getInvite = async slug=> demoMode ? memory.get(slug) : Invite.findOne({slug}).lean();
const saveInvite = async (slug, changes)=> { if(demoMode) { const v={...memory.get(slug),...changes,updatedAt:new Date()}; memory.set(slug,v); return v; } return Invite.findOneAndUpdate({slug}, {$set:changes}, {new:true}).lean(); };
const demoInvite = { name:'friend', slug:'demo', message:'We’re celebrating our birthdays together, and would love you to join us.', songId:'', songUrl:'', photos:[], status:'pending', views:0, responseHistory:[] };
const app = express();
app.set('trust proxy', 1);
app.use(helmet({referrerPolicy:{policy:'strict-origin-when-cross-origin'},contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://www.youtube.com','https://s.ytimg.com'],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'",'data:','blob:'],frameSrc:['https://www.youtube.com','https://www.youtube-nocookie.com'],connectSrc:["'self'"],upgradeInsecureRequests:production?[]:null}},crossOriginEmbedderPolicy:false}));
app.use(express.json({limit:'64kb'}));
app.use(session({ name:'birthday.sid', secret:process.env.SESSION_SECRET, resave:false, saveUninitialized:false, cookie:{httpOnly:true,sameSite:'lax',secure:production,maxAge:8*60*60*1000}, ...(demoMode?{}:{store:MongoStore.create({client:mongoose.connection.getClient(),collectionName:'sessions'})}) }));
app.use('/api',rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-8',legacyHeaders:false,skip:req=>req.path.startsWith('/photo-uploads')}));
app.use('/api', (req,res,next)=> {res.set('Cache-Control','no-store'); if(['POST','PUT','PATCH','DELETE'].includes(req.method)){ const origin=req.get('origin'); if(origin && origin !== new URL(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT||3000}`).origin) return res.status(403).json({error:'Request origin is not allowed.'}); } next(); });
const admin = (req,res,next)=>req.session.admin?next():res.status(401).json({error:'Please sign in.'});
const csrf = (req,res,next)=> { const a=Buffer.from(req.get('x-csrf-token')||''); const b=Buffer.from(req.session.csrf||''); return a.length && a.length===b.length && timingSafeEqual(a,b)? next():res.status(403).json({error:'Session expired. Refresh and try again.'}); };
const blobPhoto=url=>/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(url||'');
async function deletePhoto(url){
 if(!url)return;
 if(blobPhoto(url)){await del(url).catch(()=>{});return;}
 if(url.startsWith('/media/')&&!demoMode){const id=url.slice('/media/'.length);if(mongoose.isValidObjectId(id))await photoBucket.delete(new mongoose.Types.ObjectId(id)).catch(()=>{});return;}
 await unlink(path.join(uploadsDir,path.basename(url))).catch(()=>{});
}
async function uploadedImageStream(upload){
 const cursor=PhotoUploadPart.find({uploadId:upload._id}).sort({index:1}).select('data').lean().cursor();
 return Readable.from((async function*(){for await(const part of cursor)yield part.data;})());
}
app.get('/api/upload-config',admin,(req,res)=>res.json({database:!demoMode}));
app.post('/api/photo-uploads',admin,csrf,async(req,res)=>{
 const {slug,field}=req.body||{},size=Number(req.body?.size),filename=path.basename(String(req.body?.filename||''));
 if(!validSlug(slug)||!['profile','memory'].includes(field))return res.status(400).json({error:'Choose a valid invitation and photo type.'});
 if(!filename||!Number.isSafeInteger(size)||size<1)return res.status(400).json({error:'Choose a valid image file.'});
 const invite=await getInvite(slug);if(!invite)return res.status(404).json({error:'Invitation not found.'});
 if(field==='memory'&&(invite.photos?.length||0)>=12)return res.status(400).json({error:'This invitation already has 12 photos.'});
 const chunkCount=Math.ceil(size/uploadChunkSize);
 if(!Number.isSafeInteger(chunkCount))return res.status(400).json({error:'This file is too large to upload safely.'});
 const upload=await PhotoUpload.create({slug,field,sessionId:req.sessionID,filename,contentType:String(req.body?.contentType||''),size,chunkCount});
 res.status(201).json({id:String(upload._id),chunkSize:uploadChunkSize,chunkCount});
});
app.put('/api/photo-uploads/:id/:index',admin,csrf,express.raw({type:'application/octet-stream',limit:'4mb'}),async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({error:'Upload session not found.'});
 const upload=await PhotoUpload.findOne({_id:req.params.id,sessionId:req.sessionID});if(!upload)return res.status(404).json({error:'Upload session expired. Start again.'});
 const index=Number(req.params.index);if(!Number.isInteger(index)||index<0||index>=upload.chunkCount||!Buffer.isBuffer(req.body))return res.status(400).json({error:'Invalid upload chunk.'});
 const expected=Math.min(uploadChunkSize,upload.size-index*uploadChunkSize);if(req.body.length!==expected)return res.status(400).json({error:'Upload chunk was incomplete. Please retry.'});
 await PhotoUploadPart.updateOne({uploadId:upload._id,index},{$set:{data:req.body,expiresAt:new Date(Date.now()+24*60*60*1000)}},{upsert:true});
 res.json({ok:true,index});
});
app.post('/api/photo-uploads/:id/complete',admin,csrf,async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({error:'Upload session not found.'});
 const upload=await PhotoUpload.findOne({_id:req.params.id,sessionId:req.sessionID});if(!upload)return res.status(404).json({error:'Upload session expired. Start again.'});
 if(await PhotoUploadPart.countDocuments({uploadId:upload._id})!==upload.chunkCount)return res.status(400).json({error:'Some photo data is missing. Please retry the upload.'});
 const invite=await getInvite(upload.slug);if(!invite)return res.status(404).json({error:'Invitation not found.'});
 if(upload.field==='memory'&&(invite.photos?.length||0)>=12)return res.status(400).json({error:'This invitation already has 12 photos.'});
 let output,committed=false;try{
  const contentType=/^image\/[a-z0-9.+-]+$/i.test(upload.contentType||'')?upload.contentType:'application/octet-stream';
  output=photoBucket.openUploadStream(upload.filename,{metadata:{slug:upload.slug,field:upload.field,contentType,originalName:upload.filename}});
  await pipeline(await uploadedImageStream(upload),output);
  const imageUrl=`/media/${output.id}`;
  const updated=upload.field==='profile'?await saveInvite(upload.slug,{profilePhoto:imageUrl}):await saveInvite(upload.slug,{photos:[...(invite.photos||[]),imageUrl]});
  committed=true;
  if(upload.field==='profile'&&invite.profilePhoto)await deletePhoto(invite.profilePhoto);
  await PhotoUploadPart.deleteMany({uploadId:upload._id}).catch(()=>{});await PhotoUpload.deleteOne({_id:upload._id}).catch(()=>{});
  res.json(updated);
 }catch(error){if(output?.id&&!committed)await photoBucket.delete(output.id).catch(()=>{});await PhotoUploadPart.deleteMany({uploadId:upload._id}).catch(()=>{});await PhotoUpload.deleteOne({_id:upload._id}).catch(()=>{});console.error('MongoDB photo save failed:',{mime:upload.contentType,bytes:upload.size,extension:path.extname(upload.filename).toLowerCase(),message:error.message});res.status(500).json({error:'The original photo could not be saved to MongoDB. Please try again.'});}
});
app.delete('/api/photo-uploads/:id',admin,csrf,async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.json({ok:true});
 const upload=await PhotoUpload.findOne({_id:req.params.id,sessionId:req.sessionID});if(upload){await PhotoUploadPart.deleteMany({uploadId:upload._id});await PhotoUpload.deleteOne({_id:upload._id});}res.json({ok:true});
});
app.get('/api/session',(req,res)=>res.json({authenticated:!!req.session.admin,csrf:req.session.admin?req.session.csrf:undefined,demoMode}));
app.post('/api/login',rateLimit({windowMs:15*60000,limit:10}),async(req,res,next)=>{try{const ok=await bcrypt.compare(String(req.body.password||''),passwordHash);if(req.body.username!==(process.env.ADMIN_USERNAME||'pravith17')||!ok)return res.status(401).json({error:'Incorrect username or password.'});req.session.regenerate(err=>{if(err)return next(err);req.session.admin=true;req.session.csrf=randomBytes(32).toString('hex');req.session.save(err=>err?next(err):res.json({csrf:req.session.csrf}));});}catch(e){next(e);}});
app.post('/api/logout',admin,csrf,(req,res)=>req.session.destroy(()=>{res.clearCookie('birthday.sid');res.json({ok:true});}));
app.get('/api/settings',async(req,res)=>res.json(await getSettings()));
app.put('/api/settings',admin,csrf,async(req,res)=>{const data={};for(const key of Object.keys(defaults))data[key]=cleanText(req.body[key],key.includes('Message')||['message','thankYou'].includes(key)?3000:500);if(data.mapsUrl){try{if(new URL(data.mapsUrl).protocol!=='https:')throw Error();}catch{return res.status(400).json({error:'Use a valid HTTPS map link.'});}}if(data.date&&!/^\d{4}-\d{2}-\d{2}$/.test(data.date))return res.status(400).json({error:'Choose a valid date.'});if(data.time&&!/^\d{2}:\d{2}$/.test(data.time))return res.status(400).json({error:'Choose a valid time.'});if(demoMode)memorySettings={...defaults,...data};else await Settings.updateOne({key:'party'},{$set:{data}},{upsert:true});res.json(await getSettings());});
app.get('/api/invites',admin,async(req,res)=>res.json(demoMode?[...memory.values()].reverse():await Invite.find().sort({createdAt:-1}).lean()));
function inviteData(body){const data={name:cleanText(body.name,100),description:cleanText(body.description,1500),slug:cleanText(body.slug,80),message:cleanText(body.message,3000),songUrl:cleanText(body.songUrl,500)};if(!data.name)throw Error('Enter the guest’s name.');if(!validSlug(data.slug))throw Error('Use a unique URL with lowercase letters, numbers and hyphens (up to 80 characters).');data.songId=youtubeId(data.songUrl);if(data.songId===null)throw Error('Enter a valid YouTube video link.');return data;}
app.post('/api/invites',admin,csrf,async(req,res)=>{let data;try{data=inviteData(req.body);}catch(e){return res.status(400).json({error:e.message});}if(await getInvite(data.slug))return res.status(409).json({error:'That invitation URL is already taken.'});data={...data,photos:[],status:'pending',responseHistory:[],views:0};const invite=demoMode?{...data,_id:randomUUID(),createdAt:new Date()}:await Invite.create(data);if(demoMode)memory.set(data.slug,invite);res.status(201).json(invite);});
app.put('/api/invites/:slug',admin,csrf,async(req,res)=>{let data;try{data=inviteData(req.body);}catch(e){return res.status(400).json({error:e.message});}const old=await getInvite(req.params.slug);if(!old)return res.status(404).json({error:'Invitation not found.'});if(data.slug!==old.slug&&await getInvite(data.slug))return res.status(409).json({error:'That invitation URL is already taken.'});const result=await saveInvite(old.slug,data);if(demoMode&&old.slug!==data.slug){memory.delete(old.slug);memory.set(data.slug,result);}res.json(result);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:12}});
app.post('/api/invites/:slug/profile-photo',admin,csrf,upload.single('profilePhoto'),async(req,res)=>{
 const invite=await getInvite(req.params.slug);if(!invite)return res.status(404).json({error:'Invitation not found.'});
 if(!req.file)return res.status(400).json({error:'Choose a profile picture.'});
 let file;
 try{const ext=path.extname(req.file.originalname).slice(0,16);file='/uploads/'+randomUUID()+ext;await writeFile(path.join(uploadsDir,path.basename(file)),req.file.buffer);const saved=await saveInvite(invite.slug,{profilePhoto:file});if(invite.profilePhoto)await deletePhoto(invite.profilePhoto);res.json(saved);}catch(error){console.error('Profile photo save failed:',{mime:req.file.mimetype,bytes:req.file.size,extension:path.extname(req.file.originalname).toLowerCase(),message:error.message});if(file)await unlink(path.join(uploadsDir,path.basename(file))).catch(()=>{});res.status(500).json({error:'The original photo could not be saved. Please try again.'});}
});
app.get('/api/attendees',async(req,res)=>{
 const guests=demoMode?[...memory.values()].filter(i=>i.status==='attending'):await Invite.find({status:'attending'}).select('name -_id').lean();
 res.json(guests.map(i=>({name:i.name})).sort((a,b)=>a.name.localeCompare(b.name)));
});
app.post('/api/invites/:slug/photos',admin,csrf,upload.array('photos',12),async(req,res)=>{const invite=await getInvite(req.params.slug);if(!invite)return res.status(404).json({error:'Invitation not found.'});if(!req.files?.length)return res.status(400).json({error:'Choose at least one photo.'});if(invite.photos.length+req.files.length>12)return res.status(400).json({error:'Use up to 12 photos per invitation.'});const made=[];try{for(const file of req.files){const ext=path.extname(file.originalname).slice(0,16);const name=randomUUID()+ext;await writeFile(path.join(uploadsDir,name),file.buffer);made.push('/uploads/'+name);}res.json(await saveInvite(invite.slug,{photos:[...invite.photos,...made]}));}catch(error){await Promise.all(made.map(f=>unlink(path.join(uploadsDir,path.basename(f))).catch(()=>{})));console.error('Photo save failed:',error.message);res.status(500).json({error:'The original photos could not be saved. Please try again.'});}});
app.delete('/api/invites/:slug/photos',admin,csrf,async(req,res)=>{const invite=await getInvite(req.params.slug);const file=String(req.query.url||'');if(!invite||!invite.photos.includes(file))return res.status(404).json({error:'Photo not found.'});const updated=await saveInvite(invite.slug,{photos:invite.photos.filter(p=>p!==file)});await deletePhoto(file);res.json(updated);});
app.delete('/api/invites/:slug',admin,csrf,async(req,res)=>{const invite=await getInvite(req.params.slug);if(!invite)return res.status(404).json({error:'Invitation not found.'});if(demoMode)memory.delete(invite.slug);else await Invite.deleteOne({slug:invite.slug});await Promise.all([...(invite.photos||[]),...(invite.profilePhoto?[invite.profilePhoto]:[])].map(deletePhoto));res.json({ok:true});});
app.get('/api/invites/:slug',async(req,res)=>{const invite=req.params.slug==='demo'?{...demoInvite}:await getInvite(req.params.slug);if(!invite)return res.status(404).json({error:'This invitation isn’t on the list. Check your link with Pravith or Abhishek.'});if(invite.slug!=='demo'){if(demoMode)await saveInvite(invite.slug,{views:(invite.views||0)+1,lastViewedAt:new Date()});else await Invite.updateOne({slug:invite.slug},{$inc:{views:1},$set:{lastViewedAt:new Date()}});}res.json({name:invite.name,description:invite.description||'',profilePhoto:invite.profilePhoto||'',slug:invite.slug,message:invite.message,songId:invite.songId,photos:invite.photos,status:invite.status,settings:await getSettings()});});
app.post('/api/invites/:slug/rsvp',rateLimit({windowMs:60000,limit:30}),async(req,res)=>{
 if(!['attending','declined'].includes(req.body.status))return res.status(400).json({error:'Choose a response.'});
 const response={status:req.body.status,reason:cleanText(req.body.reason,1500),freeWhen:cleanText(req.body.freeWhen,300),excuse:cleanText(req.body.excuse,300),cake:cleanText(req.body.cake,100),at:new Date()};
 if(response.status==='declined'&&!response.reason)return res.status(400).json({error:'Tell us why you can’t make it.'});
 if(req.params.slug==='demo')return res.json({ok:true,demo:true});
 if(demoMode){
  const invite=memory.get(req.params.slug);
  if(!invite)return res.status(404).json({error:'Invitation not found.'});
  if(invite.status==='attending')return response.status==='attending'?res.json({ok:true,locked:true}):res.status(409).json({error:'Your attendance is confirmed and cannot be changed.',locked:true});
  // No await between checking and committing, so concurrent demo requests cannot undo a yes.
  memory.set(invite.slug,{...invite,status:response.status,response,updatedAt:new Date(),responseHistory:[...(invite.responseHistory||[]),response].slice(-50)});
 }else{
  // Conditional update makes the attendance lock atomic, including simultaneous requests.
  const updated=await Invite.findOneAndUpdate({slug:req.params.slug,status:{$ne:'attending'}},{$set:{status:response.status,response},$push:{responseHistory:{$each:[response],$slice:-50}}});
  if(!updated){const existing=await Invite.findOne({slug:req.params.slug}).select('status').lean();if(!existing)return res.status(404).json({error:'Invitation not found.'});return response.status==='attending'?res.json({ok:true,locked:true}):res.status(409).json({error:'Your attendance is confirmed and cannot be changed.',locked:true});}
 }
 res.json({ok:true,locked:response.status==='attending'});
});
app.get('/media/:id',async(req,res)=>{
 if(demoMode||!mongoose.isValidObjectId(req.params.id))return res.sendStatus(404);
 const id=new mongoose.Types.ObjectId(req.params.id);const file=await photoBucket.find({_id:id}).next();if(!file)return res.sendStatus(404);
 const url=`/media/${id}`;const invite=await getInvite(file.metadata?.slug);const field=file.metadata?.field;
 if(!invite||!(field==='profile'?invite.profilePhoto===url:field==='memory'&&invite.photos?.includes(url)))return res.sendStatus(404);
 const contentType=/^image\/[a-z0-9.+-]+$/i.test(file.metadata?.contentType||'')?file.metadata.contentType:'application/octet-stream';
 res.set({'Content-Type':contentType,'X-Content-Type-Options':'nosniff','Content-Disposition':'inline','Cache-Control':'public, max-age=3600, immutable'});const stream=photoBucket.openDownloadStream(id);stream.on('error',()=>{if(!res.headersSent)res.sendStatus(404);else res.destroy();});stream.pipe(res);
});
app.use('/uploads',express.static(uploadsDir,{maxAge:'7d',dotfiles:'deny'}));
app.use(express.static(path.join(root,'public'),{index:false}));
app.get(['/','/admin','/:slug'],(req,res)=>res.sendFile(path.join(root,'public','index.html')));
app.use((err,req,res,next)=>{if(err.code===11000)return res.status(409).json({error:'That invitation URL is already taken.'});if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Each photo must be smaller than 8 MB.':'Upload up to 12 photos at a time.'});console.error('Request failed:',{method:req.method,path:req.path,name:err.name,message:err.message,stack:err.stack});res.status(500).json({error:'Something went wrong. Please try again.'});});
const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`Birthday Club running at http://localhost:${port}${demoMode?' (temporary demo data)':''}`));
