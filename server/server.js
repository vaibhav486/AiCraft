import express from 'express';
import cors from 'cors';
import 'dotenv/config' ;
import { clerkMiddleware, requireAuth } from '@clerk/express'
import aiRouter from './routes/aiRoutes.js';
import connectCloudinary from './configs/cloudinary.js';
import userRouter from './routes/userRoutes.js';
import documentRouter from './routes/documentRoutes.js';
import { runMigrations } from './configs/migrations.js';


const app=express()

await connectCloudinary()
await runMigrations().catch((err) => console.error('Migration failed during startup:', err.message));

app.use(cors())
app.use(express.json())
app.use(clerkMiddleware())


app.get('/',(req, res)=>res.send('Server is Live! '))

app.use(requireAuth())
app.use('/api/ai',aiRouter)
app.use('/api/user',userRouter)
app.use('/api/documents', documentRouter)



const PORT=process.env.PORT || 3000;
app.listen(PORT,()=>{
    console.log('Server is running on port',PORT);
})