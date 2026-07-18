import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AgreementsModule } from '../agreements/agreements.module';
import { MilestoneSyncModule } from '../milestone-sync/milestone-sync.module';

@Module({
  imports: [NotificationsModule, AgreementsModule, MilestoneSyncModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
