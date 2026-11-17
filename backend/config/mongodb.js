import mongoose from "mongoose";

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

    try {
        await mongoose.connect(process.env.MONGODB_URI, { dbName: 'prescripto' });
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error.message);
        throw error;
    }
}

export default connectDB