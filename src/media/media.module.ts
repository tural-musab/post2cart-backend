import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { MinioService } from './minio.service';
import { FfmpegService } from './ffmpeg.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, MinioService, FfmpegService],
})
export class MediaModule { }
