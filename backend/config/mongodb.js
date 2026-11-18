import mongoose from "mongoose";
import { resolveDatabaseName } from "./environment.js";

let listenersRegistered = false;

const setupConnectionListeners = () => {
    if (!listenersRegistered) {
        mongoose.connection.on('connected', () => console.log("Database Connected"))
        mongoose.connection.on('error', (err) => console.error("Database Connection Error:", err.message))
        mongoose.connection.on('disconnected', () => console.log("Database Disconnected"))
        listenersRegistered = true;
    }
}

const connectDB = async () => {
    setupConnectionListeners();

    if (!process.env.MONGODB_URI) {
        const err = new Error("MONGODB_URI environment variable is not defined");
        console.error("MongoDB connection error:", err.message);
        throw err;
    }

    // Local default stays 'prescripto_test'; production must set MONGODB_DB_NAME
    // explicitly and fails here instead of silently using the test database.
    let dbName;
    try {
        dbName = resolveDatabaseName();
    } catch (err) {
        console.error("MongoDB configuration error:", err.message);
        throw err;
    }

    try {
        // await mongoose.connect(process.env.MONGODB_URI, { dbName: 'prescripto' });
        await mongoose.connect(process.env.MONGODB_URI, { dbName });
        console.log(`MongoDB database: ${mongoose.connection.db?.databaseName || dbName}`);
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error.message);
        throw error;
    }
}

export default connectDB