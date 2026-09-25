import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhook } from '@/lib/github';
export const runtime='nodejs';
export async function POST(req:NextRequest){const raw=await req.text();if(!verifyWebhook(raw,req.headers.get('x-hub-signature-256')))return NextResponse.json({error:'Invalid signature'},{status:401});return NextResponse.json({accepted:true})}
