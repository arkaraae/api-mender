import { NextRequest, NextResponse } from 'next/server';
import { authorize, listFindings } from '@/lib/core';
export const runtime='nodejs';
export function GET(req:NextRequest){const tenant=authorize(req.headers.get('authorization')?.replace(/^Bearer /,'')||undefined);if(!tenant)return NextResponse.json({error:'Unauthorized'},{status:401});return NextResponse.json({findings:listFindings(tenant)})}
