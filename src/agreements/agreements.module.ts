import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AgreementsController } from "./agreements.controller";
import { AgreementsService } from "./agreements.service";
import { AgreementSyncModule } from "./sync/agreement-sync.module";
import { AgreementValidationModule } from "./validation/agreement-validation.module";

@Module({
  imports: [AuthModule, AgreementSyncModule, AgreementValidationModule],
  controllers: [AgreementsController],
  providers: [AgreementsService],
  exports: [AgreementsService],
})
export class AgreementsModule {}
