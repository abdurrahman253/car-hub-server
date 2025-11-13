// index.js
const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

// Firebase Admin
const serviceAccount = require("./ServiceKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// === Global MongoDB Client (Reuse) ===
let client;
let db;
let productsCollection;
let importsCollection;

const connectDB = async () => {
  if (db) return db; // Reuse

  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });

    await client.connect();
    db = client.db(process.env.DB_NAME);
    productsCollection = db.collection('products');
    importsCollection = db.collection('imports');
    console.log("MongoDB connected (reused)");
    return db;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
};

// === Verify Token ===
const verifyToken = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: "No token" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.split(' ')[1]);
    req.user = { email: decoded.email, uid: decoded.uid };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};

// === Routes ===
app.get('/', (req, res) => {
  res.json({ message: 'Car Hub Server is Live!', time: new Date() });
});

// Health Check
app.get('/health', async (req, res) => {
  try {
    await connectDB();
    res.json({ status: 'OK', db: 'connected', time: new Date() });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', db: 'failed' });
  }
});

// Get All Products
app.get('/products', async (req, res) => {
  try {
    await connectDB();
    const result = await productsCollection.find().toArray();
    res.json(result);
  } catch (error) {
    console.error("GET /products error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Add Export
app.post('/products', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const newProduct = { ...req.body, createdBy: req.user.email, createdAt: new Date() };
    const result = await productsCollection.insertOne(newProduct);
    res.json({ success: true, insertedId: result.insertedId.toString() });
  } catch (error) {
    console.error("POST /products error:", error);
    res.status(500).json({ success: false });
  }
});

// My Exports
app.get('/my-exports', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const result = await productsCollection.find({ createdBy: req.user.email }).toArray();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// DELETE Product
app.delete('/products/:id', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
    await connectDB();
    const result = await productsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
      createdBy: req.user.email
    });
    res.json({ success: result.deletedCount > 0 });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// UPDATE Product
app.patch('/products/:id', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false });
    await connectDB();
    const result = await productsCollection.updateOne(
      { _id: new ObjectId(req.params.id), createdBy: req.user.email },
      { $set: req.body }
    );
    res.json({ success: result.matchedCount > 0 });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// === Vercel Export ===
module.exports = app;