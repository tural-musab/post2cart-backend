import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';

/**
 * Controller for handling operations related to Tenants and Memberships.
 * E.g., creating a tenant, verifying a user's membership.
 * Note: Actual guard implementations will go here once Auth is connected.
 */
@Controller('tenants')
export class TenantsController {
    constructor(private readonly tenantsService: TenantsService) { }

    @Post()
    async createTenant(@Body('name') name: string, @Body('userId') userId: string) {
        return this.tenantsService.createTenant(name, userId);
    }

    @Get(':id')
    async getTenant(@Param('id') tenantId: string) {
        return this.tenantsService.getTenant(tenantId);
    }
}
