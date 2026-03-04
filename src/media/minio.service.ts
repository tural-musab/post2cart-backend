import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioService {
    private readonly minioClient: Minio.Client;
    private readonly logger = new Logger(MinioService.name);
    private readonly bucketName: string;

    constructor(private readonly configService: ConfigService) {
        this.bucketName = this.configService.get<string>('MINIO_BUCKET_NAME') || 'post2cart-media';

        const endPoint = this.configService.get<string>('MINIO_ENDPOINT') || 'localhost';
        const port = parseInt(this.configService.get<string>('MINIO_PORT') || '9000', 10);
        const useSSL = this.configService.get<string>('MINIO_USE_SSL') === 'true';
        const accessKey = this.configService.get<string>('MINIO_ACCESS_KEY');
        const secretKey = this.configService.get<string>('MINIO_SECRET_KEY');

        if (!accessKey || !secretKey) {
            this.logger.warn('MinIO credentials are not set in .env. Falling back to defaults for development.');
        }

        this.minioClient = new Minio.Client({
            endPoint,
            port,
            useSSL,
            accessKey: accessKey || 'minioadmin',
            secretKey: secretKey || 'minioadmin',
        });

        this.initializeBucket();
    }

    private async initializeBucket() {
        try {
            const exists = await this.minioClient.bucketExists(this.bucketName);
            if (!exists) {
                await this.minioClient.makeBucket(this.bucketName, 'us-east-1');
                this.logger.log(`Created MinIO bucket: ${this.bucketName}`);

                // Make bucket public (read-only) for serving files
                const policy = {
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Action: ['s3:GetObject'],
                            Effect: 'Allow',
                            Principal: '*',
                            Resource: [`arn:aws:s3:::${this.bucketName}/*`],
                        },
                    ],
                };
                await this.minioClient.setBucketPolicy(this.bucketName, JSON.stringify(policy));
            }
        } catch (error) {
            this.logger.error(`Error initializing bucket ${this.bucketName}: ${error.message}`);
        }
    }

    async uploadFile(filePath: string, destinationObject: string, contentType: string): Promise<string> {
        try {
            await this.minioClient.fPutObject(this.bucketName, destinationObject, filePath, {
                'Content-Type': contentType,
            });

            // Format URL based on config
            const endPoint = this.configService.get<string>('MINIO_ENDPOINT') || 'localhost';
            const port = this.configService.get<string>('MINIO_PORT') || '9000';
            const protocol = this.configService.get<string>('MINIO_USE_SSL') === 'true' ? 'https' : 'http';

            const fileUrl = `${protocol}://${endPoint}:${port}/${this.bucketName}/${destinationObject}`;
            this.logger.log(`Successfully uploaded to MinIO: ${fileUrl}`);
            return fileUrl;
        } catch (error) {
            this.logger.error(`Failed to upload ${filePath} to MinIO: ${error.message}`);
            throw new InternalServerErrorException('Media upload to MinIO failed');
        }
    }
}
