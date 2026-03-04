import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
const ffmpeg = require('fluent-ffmpeg');
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class FfmpegService {
    private readonly logger = new Logger(FfmpegService.name);

    /**
     * Extracts keyframes from a video file into a specified output directory.
     * Extracts 10 frames spread evenly across the video.
     * 
     * @param inputVideoPath The path to the downloaded video file
     * @param outputDirectory The directory to save the extracted frames
     * @param tenantId And tracking ID used for naming the files
     * @returns An array of absolute file paths to the extracted images
     */
    async extractKeyframes(inputVideoPath: string, outputDirectory: string, videoId: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            this.logger.log(`Starting frame extraction for video: ${inputVideoPath}`);

            if (!fs.existsSync(outputDirectory)) {
                fs.mkdirSync(outputDirectory, { recursive: true });
            }

            const filePrefix = `frame_${videoId}_`;

            ffmpeg(inputVideoPath)
                .on('end', () => {
                    this.logger.log(`Successfully extracted frames for ${videoId}`);
                    // Read the output directory to get the list of generated files
                    fs.readdir(outputDirectory, (err, files) => {
                        if (err) {
                            return reject(new InternalServerErrorException('Failed to read extracted frames'));
                        }
                        const outputFiles = files
                            .filter(f => f.startsWith(filePrefix))
                            .map(f => path.join(outputDirectory, f));
                        resolve(outputFiles);
                    });
                })
                .on('error', (err: any) => {
                    this.logger.error(`FFmpeg Error extracting frames for ${videoId}: ${err.message}`);
                    reject(new InternalServerErrorException('Video processing failed'));
                })
                // Extract ~10 screenshots, size them proportionally
                .screenshots({
                    count: 10,
                    folder: outputDirectory,
                    filename: `${filePrefix}%i.jpg`,
                    size: '1080x?' // Ensure minimum quality for AI
                });
        });
    }
}
