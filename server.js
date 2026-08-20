import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import multer from "multer";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME";

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

fs.mkdirSync("./data",{recursive:true});
fs.mkdirSync("./uploads",{recursive:true});

const db = new Database("./data/hashmi.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'owner',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
 id TEXT PRIMARY KEY,
 customer_name TEXT NOT NULL,
 phone TEXT NOT NULL,
 branch TEXT,
 address TEXT,
 total INTEGER NOT NULL DEFAULT 0,
 payment_method TEXT,
 payment_status TEXT DEFAULT 'pending',
 status TEXT DEFAULT 'Order Received',
 eta_minutes INTEGER,
 delivery_person TEXT,
 customer_message TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id TEXT NOT NULL,
 item_name TEXT NOT NULL,
 qty INTEGER NOT NULL,
 price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracking_events(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id TEXT NOT NULL,
 status TEXT NOT NULL,
 eta_minutes INTEGER,
 delivery_person TEXT,
 message TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_proofs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id TEXT NOT NULL,
 file_path TEXT NOT NULL,
 transaction_ref TEXT,
 status TEXT DEFAULT 'Payment Pending Verification',
 created_at TEXT NOT NULL
);
`);
const now=()=>new Date().toISOString();

// Create the single owner admin...
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const existingAdmin = db
    .prepare("SELECT id FROM admins WHERE email=?")
    .get(ADMIN_EMAIL);

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    db.prepare(`
      INSERT INTO admins (email, password_hash, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).run(ADMIN_EMAIL, passwordHash, now());
  }
}

function auth(req,res,next){
  try{
    const h=req.headers.authorization||"";
    if(!h.startsWith("Bearer ")) return res.status(401).json({error:"Unauthorized"});
    req.user=jwt.verify(h.slice(7),JWT_SECRET);
    next();
  }catch{return res.status(401).json({error:"Invalid or expired token"});}
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"hashmi-platter-house"}));

app.post("/api/auth/login",async(req,res)=>{
  const {email,password}=req.body||{};
  const a=db.prepare("SELECT * FROM admins WHERE email=?").get(email||"");
  if(!a || !(await bcrypt.compare(password||"",a.password_hash)))
    return res.status(401).json({error:"Invalid email or password"});
  const token=jwt.sign({sub:a.id,email:a.email,role:a.role},JWT_SECRET,{expiresIn:"8h"});
  res.json({token,admin:{id:a.id,email:a.email,role:a.role}});
});

app.get("/api/orders",auth,(req,res)=>{
  res.json(db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all());
});

app.post("/api/orders",(req,res)=>{
  const {id,customer_name,phone,branch,address,total,payment_method,items=[]}=req.body||{};
  if(!id||!customer_name||!phone) return res.status(400).json({error:"Missing order fields"});
  const t=now();
  const tx=db.transaction(()=>{
    db.prepare(`INSERT INTO orders
      (id,customer_name,phone,branch,address,total,payment_method,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id,customer_name,phone,branch||"",address||"",Number(total||0),payment_method||"Cash on Delivery",t,t);
    const stmt=db.prepare("INSERT INTO order_items(order_id,item_name,qty,price) VALUES(?,?,?,?)");
    for(const x of items) stmt.run(id,x.name,Number(x.qty||1),Number(x.price||0));
    db.prepare("INSERT INTO tracking_events(order_id,status,created_at) VALUES(?,?,?)").run(id,"Order Received",t);
  });
  tx();
  res.status(201).json({ok:true,id});
});

app.get("/api/orders/:id/tracking",(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Order not found"});
  const events=db.prepare("SELECT * FROM tracking_events WHERE order_id=? ORDER BY created_at").all(req.params.id);
  res.json({order,events});
});

app.post("/api/orders/:id/tracking",auth,async(req,res)=>{
  const {status,eta_minutes,delivery_person,message}=req.body||{};
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Order not found"});
  const t=now();
  db.prepare(`UPDATE orders SET status=?,eta_minutes=?,delivery_person=?,customer_message=?,updated_at=? WHERE id=?`)
    .run(status||order.status,eta_minutes==null?order.eta_minutes:Number(eta_minutes),delivery_person||"",message||"",t,req.params.id);
  db.prepare(`INSERT INTO tracking_events(order_id,status,eta_minutes,delivery_person,message,created_at)
    VALUES(?,?,?,?,?,?)`).run(req.params.id,status||order.status,eta_minutes||null,delivery_person||"",message||"",t);
  res.json({ok:true,order:db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id)});
});

const upload=multer({dest:"./uploads/",limits:{fileSize:8*1024*1024}});
app.post("/api/orders/:id/payment-proof",upload.single("proof"),(req,res)=>{
  if(!req.file) return res.status(400).json({error:"Proof image required"});
  const exists=db.prepare("SELECT id FROM orders WHERE id=?").get(req.params.id);
  if(!exists){fs.unlinkSync(req.file.path);return res.status(404).json({error:"Order not found"});}
  const r=db.prepare(`INSERT INTO payment_proofs(order_id,file_path,transaction_ref,created_at)
    VALUES(?,?,?,?)`).run(req.params.id,req.file.path,req.body.transaction_ref||"",now());
  res.status(201).json({ok:true,id:r.lastInsertRowid});
});

app.get("/api/reports/summary",auth,(req,res)=>{
  const total=db.prepare("SELECT COUNT(*) c FROM orders").get().c;
  const sales=db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status='Delivered'").get().s;
  res.json({totalOrders:total,deliveredSales:sales});
});

/* Website */
app.use(express.static("./Public"));
app.get("*",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).json({error:"API route not found"});
  res.sendFile(process.cwd()+"/public/index.html");
});

app.listen(PORT,()=>console.log(`Hashmi Platter House running on port ${PORT}`));
