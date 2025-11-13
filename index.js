const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const serviceAccount = require("./ServiceKey.json");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config(); // <-- Load .env variables

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());


// Firebase Admin SDK setup
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});



// MongoDB connection string (secured)
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.jnmaw82.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});



// Token verification middleware
const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized: No token" });
  }

  const token = authorization.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      email: decodedToken.email,
      uid: decodedToken.uid
    };

    next(); 
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};





app.get('/', (req, res) => {
  res.send('Hello World!!');
});

async function run() {
  try {
    await client.connect();

    // Database and Collections
    const db = client.db(process.env.DB_NAME);
    const productsCollection = db.collection('products');
    const importsCollection = db.collection('imports')

    // Get All Products
    app.get('/products', async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });


  // Get Latest 6 Products
app.get('/latest-products', async (req, res) => {
  try {
    const cursor = productsCollection
      .find()
      .sort({ created_at: -1 })  
      .limit(6);                

    const result = await cursor.toArray();

    res.send({
      success: true,
      result
    });
  } catch (error) {
    console.error("Error fetching latest products:", error);
    res.status(500).send({ success: false, message: "Server error" });
  }
});



// Get Product Details 
app.get('/products/:id', verifyToken , async (req, res) => {
  try {
    const id = req.params.id;

    // 1. Id validation
    if (!ObjectId.isValid(id)) {
      return res.send({
        success: false,
        result: null,
        message: "Invalid ID format"
      });
    }

    const query = { _id: new ObjectId(id) };
    const result = await productsCollection.findOne(query);

    // if product not found 
    if (!result) {
      return res.send({
        success: false,
        result: null,
        message: "Product not found"
      });
    }

    // success message 
    res.send({
      success: true,
      result
    });

  } catch (error) {
    console.error("Product fetch error:", error);
    res.status(500).send({
      success: false,
      result: null,
      message: "Server error",
      error: error.message
    });
  }
});








// import-product
app.post('/import-product', verifyToken, async (req, res) => {
  try {
    const { productId, importQuantity = 1 } = req.body;
    const userEmail = req.user.email;

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }

    const qty = Number(importQuantity);
    if (qty < 1) {
      return res.status(400).json({ success: false, message: "Invalid quantity" });
    }

    const product = await productsCollection.findOne({ _id: new ObjectId(productId) });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    if (qty > product.availableQuantity) {
      return res.status(400).json({ success: false, message: "Not enough stock" });
    }

    // Check if already imported
    const existingImport = await importsCollection.findOne({
      userEmail,
      productId: new ObjectId(productId)
    });

    let importId;

    if (existingImport) {
      // Update existing
      await importsCollection.updateOne(
        { _id: existingImport._id },
        { $inc: { importedQuantity: qty } }
      );
      importId = existingImport._id;
    } else {
      // Create new
      const result = await importsCollection.insertOne({
        userEmail,
        productId: new ObjectId(productId),
        importedQuantity: qty,
        importedAt: new Date(),
        status: "pending"
      });
      importId = result.insertedId;
    }

    // Reduce stock
    await productsCollection.updateOne(
      { _id: new ObjectId(productId) },
      { $inc: { availableQuantity: -qty } }
    );

    res.json({ success: true, importId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Import failed" });
  }
});




// GET: My Imports
app.get('/my-imports', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    const imports = await importsCollection.aggregate([
      { $match: { userEmail } },
      {
        $group: {
          _id: "$productId",
          importedQuantity: { $sum: "$importedQuantity" },
          importIds: { $push: "$_id" } // for removal
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
          _id: "$_id", 
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

    res.json({ success: true, result: imports });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// DELETE: Remove Import
app.delete('/my-imports/product/:productId', verifyToken, async (req, res) => {
  try {
    const productId = req.params.productId;
    const userEmail = req.user.email;

    if (!ObjectId.isValid(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }

    // Find any import of this product
    const importDoc = await importsCollection.findOne({
      userEmail,
      productId: new ObjectId(productId)
    });

    if (!importDoc) {
      return res.status(404).json({ success: false, message: "No import found" });
    }

    const qtyToRemove = importDoc.importedQuantity >= 1 ? 1 : importDoc.importedQuantity;

    if (importDoc.importedQuantity === 1) {
      // Remove document
      await importsCollection.deleteOne({ _id: importDoc._id });
    } else {
      // Reduce quantity
      await importsCollection.updateOne(
        { _id: importDoc._id },
        { $inc: { importedQuantity: -1 } }
      );
    }

    // Restore stock
    await productsCollection.updateOne(
      { _id: new ObjectId(productId) },
      { $inc: { availableQuantity: 1 } }
    );

    res.json({ success: true, productId });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ success: false });
  }
});








// search 
app.get("/search", async (req, res) => {
  try {
    const search_text = req.query.search?.trim();
    if (!search_text) return res.send([]);

    const result = await productsCollection
      .find({ productName: { $regex: search_text, $options: "i" } })
      .limit(20)
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});






    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
