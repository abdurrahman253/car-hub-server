const express = require('express');
const cors = require('cors');
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config(); // <-- Load .env variables

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection string (secured)
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.jnmaw82.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

app.get('/', (req, res) => {
  res.send('Hello World!!');
});

async function run() {
  try {
    await client.connect();

    // Database and Collections
    const db = client.db(process.env.DB_NAME);
    const productsCollection = db.collection('products');

    // ✅ Get All Products
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
app.get('/products/:id', async (req, res) => {
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
