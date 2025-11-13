const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// === Firebase Admin - Environment Variable ===
let adminApp;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  adminApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error("Firebase init error:", error);
}

// === MongoDB: Global Client Reuse ===
let client;
let db;
let productsCollection;
let importsCollection;

const connectDB = async () => {
  if (db) return db;

  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
      maxPoolSize: 5,
      minPoolSize: 1,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });

    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("MongoDB connected!");

    db = client.db(process.env.DB_NAME);
    productsCollection = db.collection('products');
    importsCollection = db.collection('imports');
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
    const decoded = await adminApp.auth().verifyIdToken(auth.split(' ')[1]);
    req.user = { email: decoded.email, uid: decoded.uid };
    next();
  } catch (error) {
    console.error("Token error:", error);
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};

// === Routes ===
app.get('/', (req, res) => {
  res.json({ message: 'Car Hub Server Live!', timestamp: new Date().toISOString() });
});

// Health Check
app.get('/health', async (req, res) => {
  try {
    await connectDB();
    res.json({ status: 'OK', db: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({ status: 'ERROR', db: 'failed', error: error.message });
  }
});

// Get All Products
app.get('/products', async (req, res) => {
  try {
    await connectDB();
    const result = await productsCollection.find({}).limit(50).toArray();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("GET /products:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Add Export
app.post('/products', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const newProduct = { 
      ...req.body, 
      createdBy: req.user.email, 
      createdAt: new Date() 
    };
    const result = await productsCollection.insertOne(newProduct);
    res.json({ success: true, insertedId: result.insertedId.toString() });
  } catch (error) {
    console.error("POST /products:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// My Exports
app.get('/my-exports', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const result = await productsCollection.find({ createdBy: req.user.email }).toArray();
    res.json({ success: true, result });
  } catch (error) {
    console.error("GET /my-exports:", error);
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
    console.error("DELETE /products:", error);
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
    console.error("PATCH /products:", error);
    res.status(500).json({ success: false });
  }
});

// Import Product
app.post('/import-product', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const { productId, importQuantity = 1 } = req.body;
    const qty = Number(importQuantity);
    if (!ObjectId.isValid(productId) || qty < 1) {
      return res.status(400).json({ success: false });
    }

    const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
    if (!product || qty > product.availableQuantity) {
      return res.status(400).json({ success: false, message: "Stock insufficient" });
    }

    const existing = await importsCollection.findOne({
      userEmail: req.user.email,
      productId: new ObjectId(productId)
    });

    if (existing) {
      await importsCollection.updateOne(
        { _id: existing._id },
        { $inc: { importedQuantity: qty } }
      );
    } else {
      await importsCollection.insertOne({
        userEmail: req.user.email,
        productId: new ObjectId(productId),
        importedQuantity: qty,
        importedAt: new Date(),
        status: "pending"
      });
    }

    await productsCollection.updateOne(
      { _id: new ObjectId(productId) },
      { $inc: { availableQuantity: -qty } }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("POST /import-product:", error);
    res.status(500).json({ success: false });
  }
});

// My Imports
app.get('/my-imports', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const result = await importsCollection.aggregate([
      { $match: { userEmail: req.user.email } },
      {
        $group: {
          _id: "$productId",
          importedQuantity: { $sum: "$importedQuantity" },
          importIds: { $push: "$_id" }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product'
        }
      },
      { $unwind: '$product' },
      {
        $project: {
          productId: "$_id",
          productImage: "$product.productImage",
          productName: "$product.productName",
          price: "$product.price",
          originCountry: "$product.originCountry",
          rating: "$product.rating",
          importedQuantity: 1
        }
      }
    ]).toArray();
    res.json({ success: true, result });
  } catch (error) {
    console.error("GET /my-imports:", error);
    res.status(500).json({ success: false });
  }
});

// Remove Import
app.delete('/my-imports/product/:productId', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.productId)) return res.status(400).json({ success: false });
    await connectDB();

    const importDoc = await importsCollection.findOne({
      userEmail: req.user.email,
      productId: new ObjectId(req.params.productId)
    });

    if (!importDoc) return res.status(404).json({ success: false });

    if (importDoc.importedQuantity === 1) {
      await importsCollection.deleteOne({ _id: importDoc._id });
    } else {
      await importsCollection.updateOne(
        { _id: importDoc._id },
        { $inc: { importedQuantity: -1 } }
      );
    }

    await productsCollection.updateOne(
      { _id: new ObjectId(req.params.productId) },
      { $inc: { availableQuantity: 1 } }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("DELETE /my-imports:", error);
    res.status(500).json({ success: false });
  }
});

// Search
app.get('/search', async (req, res) => {
  try {
    const q = req.query.search?.trim();
    if (!q) return res.json([]);
    await connectDB();
    const result = await productsCollection
      .find({ productName: { $regex: q, $options: 'i' } })
      .limit(20)
      .toArray();
    res.json(result);
  } catch (error) {
    console.error("GET /search:", error);
    res.status(500).json({ success: false });
  }
});

// === Vercel Export ===
module.exports = app;