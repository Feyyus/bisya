import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const prisma = new PrismaClient();

interface FoodTriggerRecord {
  trigger: string;
  searchQuery: string;
}

async function parseCSV(filePath: string): Promise<FoodTriggerRecord[]> {
  const records: FoodTriggerRecord[] = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let isHeader = true;
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    if (isHeader) {
      isHeader = false;
      continue;
    }

    const [trigger, searchQuery] = line.split(",").map((field) => field.trim());
    if (trigger && searchQuery) {
      records.push({ trigger, searchQuery });
    }
  }

  return records;
}

async function importFoodTriggers() {
  try {
    const csvPath = path.join(__dirname, "food-triggers.csv");

    if (!fs.existsSync(csvPath)) {
      throw new Error(`CSV file not found at ${csvPath}`);
    }

    console.log("Parsing CSV file...");
    const records = await parseCSV(csvPath);

    if (records.length === 0) {
      throw new Error("No records found in CSV file");
    }

    console.log(`Found ${records.length} records in CSV`);

    // Clear existing triggers with chatId=0 to ensure clean import
    console.log("Clearing existing global template triggers...");
    const deleteResult = await prisma.foodTrigger.deleteMany({
      where: { chatId: 0n },
    });
    console.log(`Deleted ${deleteResult.count} existing records`);

    // Import records using upsert to handle duplicates
    console.log(`Importing ${records.length} food triggers...`);

    for (const record of records) {
      await prisma.foodTrigger.upsert({
        where: {
          trigger_chatId: {
            trigger: record.trigger,
            chatId: 0n,
          },
        },
        update: {
          searchQuery: record.searchQuery,
        },
        create: {
          chatId: 0n,
          trigger: record.trigger,
          searchQuery: record.searchQuery,
        },
      });
    }

    // Verify exactly 216 rows were imported
    const count = await prisma.foodTrigger.count({
      where: { chatId: 0n },
    });

    console.log(`\nImport Summary:`);
    console.log(`  Imported: ${records.length} records from CSV`);
    console.log(`  Verified in DB: ${count} records with chatId=0`);

    if (count !== 216) {
      throw new Error(
        `Expected 216 rows in database, but found ${count}. Import verification failed.`
      );
    }

    console.log(`\n✓ All 216 food triggers imported successfully!`);

    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error("Import failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

importFoodTriggers();
