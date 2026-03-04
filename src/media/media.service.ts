import { Injectable, Logger } from '@nestjs/common';
import { MinioService } from './minio.service';
import { FfmpegService } from './ffmpeg.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { randomUUID } from 'crypto';

@Injectable()
export class MediaService {
    private readonly logger = new Logger(MediaService.name);

    constructor(
        private readonly minioService: MinioService,
        private readonly ffmpegService: FfmpegService,
        private readonly configService: ConfigService,
    ) { }

    /**
     * Processes the media asynchronously.
     * Downloads the video, extracts frames, uploads to MinIO, and calls the n8n webhook back.
     */
    async processMediaAsync(
        tenantId: string,
        platformPostId: string,
        mediaUrl: string,
        n8nCallbackUrl: string,
        payloadInfo: any
    ) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post2cart-media-'));
        const videoId = randomUUID();
        const videoExt = mediaUrl.split('?')[0].split('.').pop() || 'mp4';
        const videoFilePath = path.join(tempDir, `video_${videoId}.${videoExt}`);

        try {
            this.logger.log(`[${tenantId}] Started background processing for post ${platformPostId}`);

            // 1. Download Video
            await this.downloadFile(mediaUrl, videoFilePath);

            // 2. Upload Original Video to MinIO
            const videoMinioPath = `${tenantId}/videos/${platformPostId}_${videoId}.${videoExt}`;
            const uploadedVideoUrl = await this.minioService.uploadFile(videoFilePath, videoMinioPath, 'video/mp4');

            // 3. Extract Keyframes
            const framesDir = path.join(tempDir, 'frames');
            const framePaths = await this.ffmpegService.extractKeyframes(videoFilePath, framesDir, videoId);

            // 4. Upload Frames to MinIO
            const uploadedFrameUrls: string[] = [];
            for (let i = 0; i < framePaths.length; i++) {
                const framePath = framePaths[i];
                const frameMinioPath = `${tenantId}/frames/${platformPostId}_${videoId}_${i}.jpg`;
                const uploadedUrl = await this.minioService.uploadFile(framePath, frameMinioPath, 'image/jpeg');
                uploadedFrameUrls.push(uploadedUrl);
            }

            this.logger.log(`[${tenantId}] Successfully uploaded ${uploadedFrameUrls.length} frames and 1 video to MinIO.`);

            // 5. Callback to n8n Webhook
            await this.notifyN8n(n8nCallbackUrl, {
                status: 'success',
                tenantId,
                platformPostId,
                videoUrl: uploadedVideoUrl,
                frameUrls: uploadedFrameUrls,
                originalPayload: payloadInfo
            });

        } catch (error) {
            this.logger.error(`[${tenantId}] Background processing failed: ${error.message}`);

            // Notify n8n of the failure so the workflow doesn't hang indefinitely
            await this.notifyN8n(n8nCallbackUrl, {
                status: 'error',
                tenantId,
                platformPostId,
                error: error.message,
                originalPayload: payloadInfo
            }).catch(e => this.logger.error(`Failed to notify n8n of error: ${e.message}`));

        } finally {
            // Cleanup Temp Directory
            this.logger.log(`Cleaning up temporary files at ${tempDir}`);
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    private async downloadFile(url: string, destPath: string) {
        this.logger.log(`Downloading media from ${url} to ${destPath}`);
        const writer = fs.createWriteStream(destPath);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(destPath));
            writer.on('error', reject);
        });
    }

    private async notifyN8n(callbackUrl: string, data: any) {
        this.logger.log(`Triggering n8n callback at ${callbackUrl}`);
        if (!callbackUrl) {
            this.logger.warn('No n8n callback URL provided. Skipping webhook notification.');
            return;
        }
        await axios.post(callbackUrl, data);
    }
}
