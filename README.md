# ✨ Boutique Rails: WhatsApp Micro-Link & Bank Email Automated Dispatch

> Customized, high-converting checkout rails for boutique fashion labels, Instagram sellers, indie makers, and artisanal brands taking 10–50 orders/day on WhatsApp without gateway aggregator fees.

---

## 🎯 The Problem This Solves

| Traditional WhatsApp Selling | With Boutique Rails |
|---|---|
| **Manual Screenshot Verification**<br>Staff checks banking apps to match blurred transfer screenshots, vulnerable to fake receipt apps. | **Automated Bank Email Webhook**<br>Your bank's official credit notification email verifies the exact payable amount and marks the order 🟢 PAID. |
| **Payment Collisions**<br>Multiple customers paying ₹500 at the same time cannot be differentiated by bank narration. | **Collision-Free Paise Offsets**<br>Concurrent orders of identical value receive unique paise offsets (₹500.00, ₹500.01) with Order Ref in UPI narration. |
| **Lost Delivery Addresses**<br>Customer addresses are buried across WhatsApp threads without pincodes, causing courier RTO returns. | **Frictionless Pincode Lookup**<br>Customer inputs a 6-digit Indian pincode; City & State auto-fill. Verified address is stored on file. |
| **Manual Dispatch Entry**<br>Copy-pasting chat details into Excel at 11 PM every night. | **Live Dispatch CRM & Logistics Export**<br>Orders automatically log into the live dispatch table with 1-click CSV download for Shiprocket/Delhivery/Bluedart. |

---

## 🏗️ Architecture & Component Breakdown

```
[ Sales Rep on Phone / Web ]
         │
         ▼ Enters: Customer Name, Phone, Item, Base Price (₹)
[ Sales Link Studio (`/`) ]
         │
         ▼ Generates: brand.com/pay?ref=101 + Pre-composed WhatsApp Pitch
[ WhatsApp Chat with Customer ]
         │
         ▼ Customer taps link on mobile
[ Branded Mobile Checkout (`/pay?ref=101`) ]
   ├── 1. Pincode Auto-lookup (City/State autofilled)
   ├── 2. Verified Doorstep Courier Address
   └── 3. Direct UPI Intent (`upi://pay?pa=...`) or Dynamic QR
         │
         ▼ Customer pays via Google Pay / PhonePe / Paytm / BHIM
[ Bank Email Webhook (`/api/webhook/bank-email`) ]
   ├── Inbound email parsed from HDFC / ICICI / SBI / Axis
   ├── Matches Order Ref in narration or unique paise offset
   ├── 🟢 Updates Status to PAID with Bank UTR & Timestamp
   ├── 📦 Sets Dispatch Status to PACKING
   └── 📊 Synchronizes Live Dispatch Board (`/dispatch`) & CSV Export
```

---

## 🚀 Live Local Endpoints

* **Sales Link Studio:** [http://127.0.0.1:3000](http://127.0.0.1:3000)
* **Customer Pay Page:** [http://127.0.0.1:3000/pay](http://127.0.0.1:3000/pay)
* **Live Dispatch Sheet & CRM:** [http://127.0.0.1:3000/dispatch](http://127.0.0.1:3000/dispatch)
* **CSV Export for Logistics:** [http://127.0.0.1:3000/api/export/csv](http://127.0.0.1:3000/api/export/csv)
* **Inbound Bank Email Webhook:** `POST /api/webhook/bank-email`
