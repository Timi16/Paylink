import type { Metadata } from "next";
import { CheckoutClient } from "./_components/CheckoutClient";

export const metadata: Metadata = { title: "Pay", robots: { index: false } };

export default async function PayPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <CheckoutClient publicId={publicId} />;
}
