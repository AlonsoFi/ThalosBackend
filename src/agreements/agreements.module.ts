import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { AgreementActivityService } from './agreement-activity.service';
import { MilestoneSyncService } from './milestone-sync.service';

@Module({
  imports: [AuthModule],
  controllers: [AgreementsController],
  providers: [AgreementsService, AgreementActivityService, MilestoneSyncService],
  exports: [AgreementsService, AgreementActivityService, MilestoneSyncService],
})
export class AgreementsModule {}
