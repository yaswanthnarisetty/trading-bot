// Mark old local-only BTC records as unverified without inventing broker fills.
// Usage: node scripts/reconcileBtcLegacy.cjs [--apply]
require("dotenv/config");
require("ts-node/register");
const mongoose = require("mongoose");
const { CryptoPositionModel } = require("../src/models/CryptoPosition");
const { CryptoSessionModel } = require("../src/models/CryptoSession");
const { getDeltaDemoAccount, getDeltaDemoProduct, getDeltaDemoBtcExposure, getDeltaDemoRecentFills } = require("../src/services/DeltaService");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI_REQUIRED");
  if (process.argv.slice(2).some(a => a !== "--apply")) throw new Error("UNKNOWN_ARGUMENT");
  const product = await getDeltaDemoProduct();
  const [account, exposure, fills] = await Promise.all([
    getDeltaDemoAccount(), getDeltaDemoBtcExposure(product.id), getDeltaDemoRecentFills(product.id),
  ]);
  if (account.openPositionCount !== 0 || account.activeOrderCount !== 0 ||
      exposure.sizeContracts !== 0 || exposure.activeOrders.length !== 0 || fills.length !== 0)
    throw new Error("EXCHANGE_NOT_FLAT_OR_FILLS_REQUIRE_MANUAL_RECONCILIATION");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const query = { status: "OPEN", brokerVerification: { $ne: "UNVERIFIED_LEGACY" } };
    const [unverifiedOpen, quarantinedOpen, staleSessions] = await Promise.all([
      CryptoPositionModel.countDocuments(query),
      CryptoPositionModel.countDocuments({ status: "OPEN", brokerVerification: "UNVERIFIED_LEGACY" }),
      CryptoSessionModel.countDocuments({ status: "RUNNING" }),
    ]);
    const summary = { environment: "DELTA_TESTNET", exchangeBtcSize: exposure.sizeContracts,
      activeExchangeOrders: exposure.activeOrders.length, recentExchangeFills: fills.length,
      unverifiedOpen, quarantinedOpen, staleSessions, applied: process.argv.includes("--apply") };
    if (process.argv.includes("--apply")) {
      const now = new Date();
      const [positions, sessions] = await Promise.all([
        CryptoPositionModel.updateMany(query, { $set: { brokerVerification: "UNVERIFIED_LEGACY", brokerVerifiedAt: now } }),
        CryptoSessionModel.updateMany({ status: "RUNNING" }, { $set: {
          status: "STOPPED", stopReason: "LEGACY_ENGINE_RETIRED", stoppedAt: now,
        } }),
      ]);
      summary.quarantinedNow = positions.modifiedCount;
      summary.sessionsRetiredNow = sessions.modifiedCount;
    }
    process.stdout.write(JSON.stringify(summary) + "\n");
  } finally { await mongoose.disconnect(); }
}

main().catch(error => { process.stderr.write(String(error.message ?? error) + "\n"); process.exitCode = 1; });
