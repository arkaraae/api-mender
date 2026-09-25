import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/core';
import { connectRepository } from '@/lib/github';
export const runtime='nodejs';
export async function POST(req:NextRequest){const tenant=authorize(req.headers.get('authorization')?.replace(/^Bearer /,'')||undefined);if(!tenant)return NextResponse.json({error:'Unauthorized'},{status:401});const body=await req.json().catch(()=>null);if(!body||!Number.isSafeInteger(body.installationId)||typeof body.fullName!=='string'||typeof body.branch!=='string')return NextResponse.json({error:'Invalid request'},{status:400});try{return NextResponse.json(await connectRepository(tenant,body.installationId,body.fullName,body.branch),{status:201})}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Connection failed'},{status:400})}}
