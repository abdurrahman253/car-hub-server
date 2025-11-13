const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());


// Firebase Admin
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Vercel: Use env var
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Local: Use file
    serviceAccount = require("./ServiceKey.json");
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin initialized");
} catch (error) {
  console.error("❌ Firebase init error:", error);
}


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
    console.log("✅ MongoDB connected!");

    db = client.db(process.env.DB_NAME);
    productsCollection = db.collection('products');
    importsCollection = db.collection('imports');
    return db;
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    throw error;
  }
};

// === Verify Token ===
const verifyToken = async (req, res, next) => {
  const auth = req.headers.authorization;
  
  if (!auth?.startsWith('Bearer ')) {
    console.log("❌ No token provided");
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  
  try {
    const token = auth.split(' ')[1];
    
    // এখানে admin লিখুন, adminApp না!
    const decoded = await admin.auth().verifyIdToken(token);
    
    req.user = { 
      email: decoded.email, 
      uid: decoded.uid 
    };
    
    console.log("✅ Token verified for:", decoded.email);
    next();
  } catch (error) {
    console.error("❌ Token verification error:", error.message);
    return res.status(401).json({ 
      success: false, 
      message: "Invalid or expired token" 
    });
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE Product
app.delete('/products/:id', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }
    await connectDB();
    const result = await productsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
      createdBy: req.user.email
    });
    res.json({ success: result.deletedCount > 0 });
  } catch (error) {
    console.error("DELETE /products:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE Product
app.patch('/products/:id', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }
    await connectDB();
    const result = await productsCollection.updateOne(
      { _id: new ObjectId(req.params.id), createdBy: req.user.email },
      { $set: req.body }
    );
    res.json({ success: result.matchedCount > 0 });
  } catch (error) {
    console.error("PATCH /products:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Import Product
app.post('/import-product', verifyToken, async (req, res) => {
  try {
    await connectDB();
    const { productId, importQuantity = 1 } = req.body;
    const qty = Number(importQuantity);
    
    if (!ObjectId.isValid(productId) || qty < 1) {
      return res.status(400).json({ success: false, message: "Invalid data" });
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
    res.status(500).json({ success: false, message: error.message });
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// Remove Import
app.delete('/my-imports/product/:productId', verifyToken, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.productId)) {
       return res.status(400).json({ success: false, message: "Invalid ID" });
    }
    await connectDB();

    const importDoc = await importsCollection.findOne({
      userEmail: req.user.email,
      productId: new ObjectId(req.params.productId)
    });

    if (!importDoc) {
      return res.status(404).json({ success: false, message: "Import not found" });
    }

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
    res.status(500).json({ success: false, message: error.message });
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// === Start Server (Local only) ===
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

module.exports = app; 