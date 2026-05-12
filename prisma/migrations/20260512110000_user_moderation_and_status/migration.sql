-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended', 'banned', 'deleted');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "statusReason" TEXT,
ADD COLUMN "statusChangedAt" TIMESTAMP(3),
ADD COLUMN "disciplineStrikeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "disciplineTier" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PersonnelReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolutionAction" TEXT,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PersonnelReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonnelReport_targetUserId_status_idx" ON "PersonnelReport"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "PersonnelReport_reporterId_createdAt_idx" ON "PersonnelReport"("reporterId", "createdAt");

-- AddForeignKey
ALTER TABLE "PersonnelReport" ADD CONSTRAINT "PersonnelReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelReport" ADD CONSTRAINT "PersonnelReport_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonnelReport" ADD CONSTRAINT "PersonnelReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
