import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, PrismaService } from "../../prisma";
import { orderBy } from "lodash";
import * as CodeGenTypes from "@amplication/code-gen-types";
import { ResourceRole, User } from "../../models";
import { Build } from "./dto/Build";
import { CreateBuildArgs } from "./dto/CreateBuildArgs";
import { FindManyBuildArgs } from "./dto/FindManyBuildArgs";
import { EnumBuildStatus } from "./dto/EnumBuildStatus";
import { FindOneBuildArgs } from "./dto/FindOneBuildArgs";
import { EntityService } from "../entity/entity.service";
import { ResourceRoleService } from "../resourceRole/resourceRole.service";
import { ResourceService } from "../resource/resource.service";
import {
  EnumActionStepStatus,
  EnumActionLogLevel,
  ActionStep,
} from "../action/dto";
import { UserService } from "../user/user.service";
import { ServiceSettingsService } from "../serviceSettings/serviceSettings.service";
import { ActionService } from "../action/action.service";
import { CommitService } from "../commit/commit.service";
import { previousBuild } from "./utils";
import { TopicService } from "../topic/topic.service";
import { ServiceTopicsService } from "../serviceTopics/serviceTopics.service";
import { PluginInstallationService } from "../pluginInstallation/pluginInstallation.service";
import { ProjectConfigurationSettingsService } from "../projectConfigurationSettings/projectConfigurationSettings.service";
import { ModuleActionService } from "../moduleAction/moduleAction.service";
import { ModuleService } from "../module/module.service";
import { EnumResourceType } from "../resource/dto/EnumResourceType";
import { Env } from "../../env";
import { AmplicationLogger } from "@amplication/util/nestjs/logging";
import { BillingService } from "../billing/billing.service";
import {
  EnumGitProvider,
  EnumPullRequestMode,
  GitProviderProperties,
} from "@amplication/util/git";
import { BillingFeature } from "@amplication/util-billing-types";
import { ILogger } from "@amplication/util/logging";
import {
  CanUserAccessBuild,
  CodeGenerationLog,
  CodeGenerationRequest,
  CreatePrFailure,
  CreatePrLog,
  CreatePrRequest,
  CreatePrSuccess,
  KAFKA_TOPICS,
  UserBuild,
  DownloadPrivatePluginsRequest,
  DownloadPrivatePluginsLog,
  DownloadPrivatePluginsSuccess,
  DownloadPrivatePluginsFailure,
  CodeGenerationFailure,
} from "@amplication/schema-registry";
import { KafkaProducerService } from "@amplication/util/nestjs/kafka";
import { GitProviderService } from "../git/git.provider.service";
import { EnumEventType } from "../../services/segmentAnalytics/segmentAnalytics.types";
import { SegmentAnalyticsService } from "../../services/segmentAnalytics/segmentAnalytics.service";
import { kebabCase } from "lodash";
import { CodeGeneratorVersionStrategy } from "../resource/dto";

const PROVIDERS_DISPLAY_NAME: { [key in EnumGitProvider]: string } = {
  [EnumGitProvider.AwsCodeCommit]: "AWS CodeCommit",
  [EnumGitProvider.Bitbucket]: "Bitbucket",
  [EnumGitProvider.Github]: "GitHub",
  [EnumGitProvider.GitLab]: "GitLab",
};
import { encryptString } from "../../util/encryptionUtil";
import { ModuleDtoService } from "../moduleDto/moduleDto.service";
import { PluginInstallation } from "../pluginInstallation/dto/PluginInstallation";
import { PackageService } from "../package/package.service";
import omitDeep from "deepdash/omitDeep";

export const HOST_VAR = "HOST";
export const CLIENT_HOST_VAR = "CLIENT_HOST";
export const GENERATE_STEP_MESSAGE = "Generating Application";
export const GENERATE_STEP_NAME = "GENERATE_APPLICATION";

export const DOWNLOAD_PRIVATE_PLUGINS_STEP_MESSAGE =
  "Downloading private plugins";
export const DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME = "DOWNLOAD_PRIVATE_PLUGINS";
export const DOWNLOAD_PRIVATE_PLUGINS_STEP_FINISH_LOG =
  "Successfully downloaded private plugins";
export const DOWNLOAD_PRIVATE_PLUGINS_STEP_FAILED_LOG =
  "Failed to download private plugins";
export const DOWNLOAD_PRIVATE_PLUGINS_STEP_RUNNING_LOG =
  "Downloading private plugins. It should take a few moments.";
export const DOWNLOAD_PRIVATE_PLUGINS_STEP_START_LOG =
  "Downloading private plugins job added to queue. Waiting for available worker...";

export const PUSH_TO_GIT_STEP_NAME = "PUSH_TO_GIT_PROVIDER";
export const PUSH_TO_GIT_STEP_MESSAGE = (gitProvider: EnumGitProvider) =>
  `Push changes to ${PROVIDERS_DISPLAY_NAME[gitProvider]}`;
export const PUSH_TO_GIT_STEP_START_LOG =
  "Pull request creation job added to queue. Waiting for available worker...";
export const PUSH_TO_GIT_STEP_FINISH_LOG = (gitProvider: EnumGitProvider) =>
  `Successfully pushed changes to ${PROVIDERS_DISPLAY_NAME[gitProvider]}`;
export const PUSH_TO_GIT_STEP_FAILED_LOG = (gitProvider: EnumGitProvider) =>
  `Push changes to ${PROVIDERS_DISPLAY_NAME[gitProvider]} failed`;

export interface CreatePullRequestGitSettings {
  gitOrganizationName: string;
  gitRepositoryName: string;
  repositoryGroupName?: string;
  baseBranchName: string;
  gitProvider: EnumGitProvider;
  gitProviderProperties: GitProviderProperties;
  commit: {
    title: string;
    body: string;
  };
}

export const ACTION_ZIP_LOG = "Creating ZIP file";
export const ACTION_JOB_DONE_LOG = "Build job done";
export const JOB_STARTED_LOG = "Build job started";
export const JOB_DONE_LOG = "Build job done";
export const ENTITIES_INCLUDE = {
  fields: true,
  permissions: {
    include: {
      permissionRoles: {
        include: {
          resourceRole: true,
        },
      },
      permissionFields: {
        include: {
          field: true,
          permissionRoles: {
            include: {
              resourceRole: true,
            },
          },
        },
      },
    },
  },
};
export const ACTION_INCLUDE = {
  action: {
    include: {
      steps: true,
    },
  },
};

export const ACTION_LOG_LEVEL: {
  [level: string]: EnumActionLogLevel;
} = {
  error: EnumActionLogLevel.Error,
  warn: EnumActionLogLevel.Warning,
  info: EnumActionLogLevel.Info,
  debug: EnumActionLogLevel.Debug,
};

const FIRST_COMMIT_MESSAGE_BODY = `Congratulations on your first commit!

We encourage you to continue exploring how Amplication can enhance your development process, including easy management of entities, API generation, and the simplification of backend services management through extensive plugin system.

Remember, [Amplication](https://amplication.com/) is the fastest way in the world to build production-ready backend services : ) 

Happy coding!`;

export function createInitialStepData(
  version: string,
  message: string
): Prisma.ActionStepCreateWithoutActionInput {
  return {
    message: "Adding task to queue",
    name: "ADD_TO_QUEUE",
    status: EnumActionStepStatus.Success,
    completedAt: new Date(),
    logs: {
      create: [
        {
          level: EnumActionLogLevel.Info,
          message: "Create build generation task",
          meta: {},
        },
        {
          level: EnumActionLogLevel.Info,
          message: `Build version: ${version}`,
          meta: {},
        },
        {
          level: EnumActionLogLevel.Info,
          message: `Build message: ${message}`,
          meta: {},
        },
      ],
    },
  };
}

const PREVIEW_PR_BODY = `Welcome to your first sync with Amplication's Preview Repo! 🚀 \n\nYou’ve taken the first step in supercharging your development. This Preview Repo is a sandbox for you to see what Amplication can do.\n\nRemember, by connecting to your own repository, you’ll have even more power - like customizing the code to fit your needs.\n\nNow, head back to Amplication, connect to your own repo and keep building! Define data entities, set up roles, and extend your service’s functionality with our versatile plugin system. The possibilities are endless.\n\n[link]\n\nThank you, and let's build something amazing together! 🚀\n\n`;

const DSG_RESOURCE_DATA_PROPERTIES_TO_REMOVE = [
  "createdAt",
  "updatedAt",
  "versionNumber",
  "lockedAt",
  "lockedByUserId",
  "deletedAt",
];

type DiffStatObject = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};
@Injectable()
export class BuildService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly entityService: EntityService,
    private readonly resourceRoleService: ResourceRoleService,
    private readonly actionService: ActionService,
    @Inject(forwardRef(() => ResourceService))
    private readonly resourceService: ResourceService,
    private readonly commitService: CommitService,
    private readonly serviceSettingsService: ServiceSettingsService,
    private readonly userService: UserService,
    private readonly kafkaProducerService: KafkaProducerService,
    private readonly topicService: TopicService,
    private readonly serviceTopicsService: ServiceTopicsService,
    private readonly pluginInstallationService: PluginInstallationService,
    private readonly packageService: PackageService,
    private readonly projectConfigurationSettingsService: ProjectConfigurationSettingsService,

    private readonly moduleActionService: ModuleActionService,
    private readonly moduleDtoService: ModuleDtoService,
    private readonly moduleService: ModuleService,
    private readonly billingService: BillingService,
    private readonly gitProviderService: GitProviderService,
    @Inject(AmplicationLogger)
    private readonly logger: AmplicationLogger,
    private analytics: SegmentAnalyticsService
  ) {
    this.host = this.configService.get(HOST_VAR);
    if (!this.host) {
      throw new Error("Missing HOST_VAR in env");
    }
  }
  host: string;

  /**
   * create function creates a new build for given resource in the DB
   * @returns the build object that return after prisma.build.create
   */
  async create(args: CreateBuildArgs): Promise<Build> {
    const resourceId = args.data.resource.connect.id;
    const user = await this.userService.findUser({
      where: {
        id: args.data.createdBy.connect.id,
      },
    });

    //TODO
    /**@todo: set version based on release when applicable */
    const commitId = args.data.commit.connect.id;
    const version = commitId.slice(commitId.length - 8);

    const latestEntityVersions = await this.entityService.getLatestVersions({
      where: { resourceId: resourceId },
    });

    const build = await this.prisma.build.create({
      ...args,
      data: {
        ...args.data,
        version,
        createdAt: new Date(),
        blockVersions: {
          connect: [],
        },
        entityVersions: {
          connect: latestEntityVersions.map((version) => ({ id: version.id })),
        },
        action: {
          create: {
            steps: {
              create: createInitialStepData(version, args.data.message),
            },
          }, //create action record
        },
      },
      include: {
        commit: true,
        resource: true,
      },
    });

    const logger = this.logger.child({
      buildId: build.id,
      resourceId: build.resourceId,
      userId: build.userId,
      user,
    });

    const resource = await this.resourceService.findOne({
      where: { id: resourceId },
    });
    if (resource.resourceType !== EnumResourceType.Service) {
      logger.info("Code generation is supported only for services");
      return;
    }

    const resourcePrivatePlugins: PluginInstallation[] =
      await this.pluginInstallationService.getInstalledPrivatePluginsForBuild(
        resourceId
      );

    if (resourcePrivatePlugins.length > 0) {
      logger.info(`${resourcePrivatePlugins.length} private plugins found.`);
      await this.downloadPrivatePlugins(
        logger,
        build,
        user,
        resourcePrivatePlugins
      );
    } else {
      logger.info(JOB_STARTED_LOG);
      await this.generate(logger, build, user);
    }

    return build;
  }

  async findMany(args: FindManyBuildArgs): Promise<Build[]> {
    return this.prisma.build.findMany(args);
  }

  async findOne(args: FindOneBuildArgs): Promise<Build | null> {
    return this.prisma.build.findUnique(args);
  }

  async updateCodeGeneratorVersion(
    buildId: string,
    codeGeneratorVersion: string
  ): Promise<void> {
    try {
      const build = await this.findOne({
        where: {
          id: buildId,
        },
      });

      if (!build) {
        this.logger.error(
          `updateCodeGeneratorVersion: Could not find build with id ${buildId}`
        );
        return;
      }

      await this.prisma.build.update({
        where: { id: buildId },
        data: { codeGeneratorVersion },
      });
    } catch (error) {
      this.logger.error(error.message, error);
    }
  }

  async getBuildStep(
    buildId: string,
    buildStepName: string
  ): Promise<ActionStep | undefined> {
    const [generateStep] = await this.prisma.build
      .findUnique({
        where: {
          id: buildId,
        },
      })
      .action()
      .steps({
        where: {
          name: buildStepName,
        },
      });

    return generateStep;
  }

  async calcBuildStatus(buildId: string): Promise<EnumBuildStatus> {
    const build = await this.prisma.build.findUnique({
      where: {
        id: buildId,
      },
      include: ACTION_INCLUDE,
    });

    if (!build.action?.steps?.length) return EnumBuildStatus.Invalid;
    const steps = build.action.steps;

    if (steps.every((step) => step.status === EnumActionStepStatus.Success))
      return EnumBuildStatus.Completed;

    if (steps.some((step) => step.status === EnumActionStepStatus.Failed))
      return EnumBuildStatus.Failed;

    return EnumBuildStatus.Running;
  }

  async onCodeGenerationSuccess(buildId: string): Promise<void> {
    const step = await this.getBuildStep(buildId, GENERATE_STEP_NAME);
    if (!step) {
      throw new Error("Could not find generate code step");
    }

    const commitWithAccount = await this.prisma.build.findUnique({
      where: { id: buildId },
      include: {
        resource: {
          select: {
            name: true,
          },
        },
        commit: {
          include: {
            user: true,
            project: true,
          },
        },
      },
    });

    this.kafkaProducerService
      .emitMessage(KAFKA_TOPICS.USER_BUILD_TOPIC, <UserBuild.KafkaEvent>{
        key: {},
        value: {
          commitId: commitWithAccount.commit.id,
          commitMessage: commitWithAccount.commit.message,
          resourceId: commitWithAccount.resourceId,
          resourceName: commitWithAccount.resource.name,
          workspaceId: commitWithAccount.commit.project.workspaceId,
          projectId: commitWithAccount.commit.projectId,
          buildId: buildId,
          projectName: commitWithAccount.commit.project.name,
          createdAt: Date.now(),
          externalId: encryptString(commitWithAccount.commit.user.id),
          envBaseUrl: this.configService.get<string>(Env.CLIENT_HOST),
        },
      })
      .catch((error) =>
        this.logger.error(`Failed to queue user build ${buildId}`, error)
      );

    await this.actionService.complete(step, EnumActionStepStatus.Success);
  }

  public async onCodeGenerationFailure(
    response: CodeGenerationFailure.Value
  ): Promise<void> {
    const { buildId } = response;

    //write the error message to the log
    await this.onDsgLog({
      buildId: buildId,
      level: "error",
      message: response.errorMessage || "Code generation failed",
    });

    const step = await this.getBuildStep(buildId, GENERATE_STEP_NAME);
    if (!step) {
      throw new Error(`Could not find generate code step for build ${buildId}`);
    }

    await this.actionService.complete(step, EnumActionStepStatus.Failed);
  }

  /**
   * Generates code for given build and saves it to storage
   * @DSG The connection between the server and the DSG (Data Service Generator)
   * @param build the build object to generate code for
   * @param user the user that triggered the build
   */
  private async generate(
    logger: ILogger,
    build: Build,
    user: User
  ): Promise<string> {
    return this.actionService.run(
      build.actionId,
      GENERATE_STEP_NAME,
      GENERATE_STEP_MESSAGE,
      async (step) => {
        const { resourceId, id: buildId, version: buildVersion } = build;

        logger.info("Preparing build generation message");

        const dsgResourceData = await this.getDSGResourceData(
          resourceId,
          buildId,
          buildVersion,
          user
        );

        logger.info("Writing build generation message to queue");

        const codeGenerationEvent: CodeGenerationRequest.KafkaEvent = {
          key: null,
          value: {
            resourceId,
            buildId,
            dsgResourceData,
          },
        };

        await this.kafkaProducerService.emitMessage(
          KAFKA_TOPICS.CODE_GENERATION_REQUEST_TOPIC,
          codeGenerationEvent
        );

        logger.info("Build generation message sent");

        return null;
      },
      true
    );
  }

  /**
   * Downloads private plugins for given build
   */
  private async downloadPrivatePlugins(
    logger: ILogger,
    build: Build,
    user: User,
    privatePlugins: PluginInstallation[]
  ): Promise<string> {
    return this.actionService.run(
      build.actionId,
      DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME,
      DOWNLOAD_PRIVATE_PLUGINS_STEP_MESSAGE,
      async (step) => {
        const { resourceId } = build;

        logger.info("Writing 'plugin download' message to queue");

        await this.onDownloadPrivatePluginLog({
          resourceId: resourceId,
          buildId: build.id,
          level: "info",
          message: DOWNLOAD_PRIVATE_PLUGINS_STEP_RUNNING_LOG,
        });

        try {
          const pluginRepoGitSettings =
            await this.resourceService.getPluginRepositoryGitSettingsByResource(
              resourceId
            );

          const downloadPrivatePluginsRequest: DownloadPrivatePluginsRequest.KafkaEvent =
            {
              key: {
                resourceId,
              },
              value: {
                ...pluginRepoGitSettings,
                buildId: build.id,
                resourceId,
                pluginIds: privatePlugins.map((plugin) => plugin.pluginId),
              },
            };

          await this.kafkaProducerService.emitMessage(
            KAFKA_TOPICS.DOWNLOAD_PRIVATE_PLUGINS_REQUEST_TOPIC,
            downloadPrivatePluginsRequest
          );

          logger.info("The 'plugin download' message sent");

          await this.onDownloadPrivatePluginLog({
            resourceId: resourceId,
            buildId: build.id,
            level: "info",
            message: DOWNLOAD_PRIVATE_PLUGINS_STEP_START_LOG,
          });

          return null;
        } catch (error) {
          await this.onDownloadPrivatePluginFailure({
            buildId: build.id,
            errorMessage: `Failed to download plugins: ${error.message}`,
          });
          logger.error(
            "Failed to send 'plugin download' message to queue",
            error
          );
        }
      },
      true
    );
  }

  private async getResourceRoles(resourceId: string): Promise<ResourceRole[]> {
    return this.resourceRoleService.getResourceRoles({
      where: {
        resource: {
          id: resourceId,
        },
      },
    });
  }

  formatDiffStat(diffStat: string): DiffStatObject {
    this.logger.debug("diffStat", { diffStat });
    const diffStatRegex =
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
    const match = diffStat?.match(diffStatRegex);
    this.logger.debug("Diff stat", { diffStat });

    if (!match) {
      return {
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
    }
    this.logger.debug("Diff stat match", match);
    const [, filesChanged, insertions, deletions] = match;
    const diffStatObj = {
      filesChanged: parseInt(filesChanged, 10),
      insertions: parseInt(insertions || "0", 10),
      deletions: parseInt(deletions || "0", 10),
    };
    this.logger.debug("Diff stat object", diffStatObj);
    return diffStatObj;
  }

  async updateBuildLOC(
    buildId: string,
    diffStat: DiffStatObject
  ): Promise<void> {
    await this.prisma.build.update({
      where: { id: buildId },
      data: {
        linesOfCodeAdded: diffStat.insertions,
        linesOfCodeDeleted: diffStat.deletions,
        filesChanged: diffStat.filesChanged,
      },
    });
  }

  public async onCreatePRSuccess(
    response: CreatePrSuccess.Value
  ): Promise<void> {
    const build = await this.findOne({ where: { id: response.buildId } });
    const steps = await this.actionService.getSteps(build.actionId);
    const step = steps.find((step) => step.name === PUSH_TO_GIT_STEP_NAME);

    try {
      await this.resourceService.reportSyncMessage(
        build.resourceId,
        "Sync Completed Successfully"
      );

      const changes = await this.commitService.getChangesByResource(
        build.commitId,
        build.resourceId
      );

      if (changes.length > 0) {
        await this.updateBuildLOC(
          response.buildId,
          this.formatDiffStat(response.diffStat)
        );
      }

      await this.actionService.logInfo(step, response.url, {
        githubUrl: response.url,
        diffStat: this.formatDiffStat(response.diffStat),
      });
      await this.actionService.logInfo(
        step,
        PUSH_TO_GIT_STEP_FINISH_LOG(response.gitProvider)
      );
      await this.actionService.complete(step, EnumActionStepStatus.Success);

      //In case this is a preview user - a success email will be sent after the first code generation
      await this.userService.handleUserPullRequestCompleted(
        build.userId,
        build.id,
        response.url
      );

      const workspace = await this.resourceService.getResourceWorkspace(
        build.resourceId
      );
      await this.billingService.reportUsage(
        workspace.id,
        BillingFeature.CodePushToGit
      );
    } catch (error) {
      await this.actionService.logInfo(
        step,
        PUSH_TO_GIT_STEP_FAILED_LOG(response.gitProvider)
      );
      await this.actionService.logInfo(step, error);
      await this.actionService.complete(step, EnumActionStepStatus.Failed);
      await this.resourceService.reportSyncMessage(
        build.resourceId,
        `Error: ${error}`
      );
    }
  }

  public async onCreatePRFailure(
    response: CreatePrFailure.Value
  ): Promise<void> {
    const build = await this.prisma.build.findUnique({
      where: { id: response.buildId },
      include: {
        createdBy: { include: { account: true } },
        resource: {
          include: { project: true },
        },
      },
    });

    const steps = await this.actionService.getSteps(build.actionId);
    const step = steps.find((step) => step.name === PUSH_TO_GIT_STEP_NAME);

    await this.resourceService.reportSyncMessage(
      build.resourceId,
      `Error: ${response.errorMessage}`
    );

    await this.actionService.logInfo(
      step,
      PUSH_TO_GIT_STEP_FAILED_LOG(response.gitProvider)
    );
    await this.actionService.log(
      step,
      EnumActionLogLevel.Error,
      response.errorMessage
    );
    await this.actionService.complete(step, EnumActionStepStatus.Failed);

    await this.analytics.trackManual({
      user: {
        accountId: build.createdBy.account.id,
        workspaceId: build.resource.project.workspaceId,
      },
      data: {
        properties: {
          resourceId: build.resource.id,
          projectId: build.resource.project.id,
          message: response.errorMessage,
        },
        event: EnumEventType.GitSyncError,
      },
    });
  }

  public async onDsgLog(logEntry: CodeGenerationLog.Value): Promise<void> {
    const step = await this.getBuildStep(logEntry.buildId, GENERATE_STEP_NAME);
    await this.actionService.logByStepId(
      step.id,
      ACTION_LOG_LEVEL[logEntry.level],
      logEntry.message
    );

    if (ACTION_LOG_LEVEL[logEntry.level] === EnumActionLogLevel.Error) {
      const build = await this.prisma.build.findUnique({
        where: { id: logEntry.buildId },
        include: {
          createdBy: { include: { account: true } },
          resource: {
            include: {
              project: {
                select: {
                  id: true,
                  workspaceId: true,
                },
              },
            },
          },
        },
      });
      await this.analytics.trackManual({
        user: {
          accountId: build.createdBy.account.id,
          workspaceId: build.resource.project.workspaceId,
        },
        data: {
          properties: {
            resourceId: build.resource.id,
            projectId: build.resource.project.id,
            message: logEntry.message,
          },
          event: EnumEventType.CodeGenerationError,
        },
      });
    }
  }

  public async onDownloadPrivatePluginSuccess(
    response: DownloadPrivatePluginsSuccess.Value
  ): Promise<void> {
    const { buildId } = response;

    const step = await this.getBuildStep(
      buildId,
      DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME
    );
    if (!step) {
      throw new Error("Could not find download private plugins step");
    }

    const build = await this.findOne({ where: { id: buildId } });

    const user = await this.userService.findUser({
      where: { id: build.userId },
    });

    const logger = this.logger.child({
      buildId: build.id,
      resourceId: build.resourceId,
      userId: build.userId,
      user,
    });

    //once all plugins are downloaded, we can start the code generation
    await this.generate(logger, build, user);

    await this.actionService.complete(step, EnumActionStepStatus.Success);
  }

  public async onDownloadPrivatePluginFailure(
    response: DownloadPrivatePluginsFailure.Value
  ): Promise<void> {
    const { buildId } = response;

    const build = await this.prisma.build.findUnique({
      where: { id: buildId },
      include: {
        createdBy: { include: { account: true } },
        resource: {
          include: { project: true },
        },
      },
    });

    //write the error message to the log
    await this.onDownloadPrivatePluginLog({
      buildId: buildId,
      level: "error",
      message: response.errorMessage,
      resourceId: build.resourceId,
    });

    const step = await this.getBuildStep(
      buildId,
      DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME
    );
    if (!step) {
      throw new Error("Could not find download private plugins step");
    }

    await this.actionService.complete(step, EnumActionStepStatus.Failed);
  }

  public async onDownloadPrivatePluginLog(
    logEntry: DownloadPrivatePluginsLog.Value
  ): Promise<void> {
    const step = await this.getBuildStep(
      logEntry.buildId,
      DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME
    );
    await this.actionService.logByStepId(
      step.id,
      ACTION_LOG_LEVEL[logEntry.level],
      logEntry.message
    );

    if (ACTION_LOG_LEVEL[logEntry.level] === EnumActionLogLevel.Error) {
      const build = await this.prisma.build.findUnique({
        where: { id: logEntry.buildId },
        include: {
          createdBy: { include: { account: true } },
          resource: {
            include: {
              project: {
                select: {
                  id: true,
                  workspaceId: true,
                },
              },
            },
          },
        },
      });
      await this.analytics.trackManual({
        user: {
          accountId: build.createdBy.account.id,
          workspaceId: build.resource.project.workspaceId,
        },
        data: {
          properties: {
            resourceId: build.resource.id,
            projectId: build.resource.project.id,
            message: logEntry.message,
            stepName: DOWNLOAD_PRIVATE_PLUGINS_STEP_NAME,
          },
          event: EnumEventType.CodeGenerationError,
        },
      });
    }
  }
  public async saveToGitProvider(buildId: string): Promise<void> {
    const build = await this.findOne({ where: { id: buildId } });

    const oldBuild = await previousBuild(
      this.prisma,
      build.resourceId,
      build.id,
      build.createdAt
    );

    const user = await this.userService.findUser({
      where: { id: build.userId },
    });

    const logger = this.logger.child({
      buildId: build.id,
      resourceId: build.resourceId,
      userId: build.userId,
      user,
    });

    const resource = await this.resourceService.resource({
      where: { id: build.resourceId },
    });

    if (!resource) {
      logger.warn("Resource was not found during pushing code to git");
      return;
    }

    const dSGResourceData = await this.getDSGResourceData(
      build.resourceId,
      build.id,
      build.version,
      user
    );
    const { resourceInfo } = dSGResourceData;

    const project = await this.prisma.project.findUnique({
      where: {
        id: resource.projectId,
      },
    });

    const existingProjectConfiguration = await this.prisma.resource.findFirst({
      where: {
        projectId: project.id,
        resourceType: EnumResourceType.ProjectConfiguration,
      },
    });
    const projectConfigurationSettings =
      await this.projectConfigurationSettingsService.findOne({
        where: { id: existingProjectConfiguration.id },
      });

    let gitSettings: CreatePullRequestGitSettings = null;
    let kafkaEventKey: string = null;

    const clientHost = this.configService.get(CLIENT_HOST_VAR);

    if (project.useDemoRepo) {
      const organizationName = this.configService.get<string>(
        Env.GITHUB_DEMO_REPO_ORGANIZATION_NAME
      );

      const installationId = this.configService.get<string>(
        Env.GITHUB_DEMO_REPO_INSTALLATION_ID
      );

      const url = `${clientHost}/${project.workspaceId}/${project.id}/${resource.id}/git-sync`;
      const buildLinkHTML = `[${url}](${url})`;

      const commitBody = PREVIEW_PR_BODY.replace("[link]", buildLinkHTML);

      gitSettings = {
        gitOrganizationName: organizationName,
        gitRepositoryName: project.demoRepoName,
        repositoryGroupName: "",
        baseBranchName: "", //leave empty to use default branch
        gitProvider: EnumGitProvider.Github,
        gitProviderProperties: {
          installationId: installationId,
        },
        commit: {
          title: "Preview PR from Amplication",
          body: commitBody,
        },
      };

      kafkaEventKey = project.demoRepoName;
    } else {
      const resourceRepository = await this.resourceService.gitRepository(
        build.resourceId
      );

      if (!resourceRepository) {
        return;
      }
      kafkaEventKey = resourceRepository.id;

      const gitOrganization =
        await this.resourceService.gitOrganizationByResource({
          where: { id: resource.id },
        });

      const commit = await this.commitService.findOne({
        where: { id: build.commitId },
      });
      const truncateBuildId = build.id.slice(build.id.length - 8);

      const commitTitle =
        (commit.message &&
          `${commit.message} (Amplication build ${truncateBuildId})`) ||
        `Amplication build ${truncateBuildId}`;

      const url = `${clientHost}/${project.workspaceId}/${project.id}/${resource.id}/builds/${build.id}`;
      const buildLinkHTML = `[${url}](${url})`;

      const commitMessage = oldBuild?.id
        ? commit.message && `Commit message: ${commit.message}.`
        : FIRST_COMMIT_MESSAGE_BODY; // this message will be shown only on the first commit to the repository

      const commitBody = `Amplication build # ${build.id}\n\n${commitMessage}\n\nBuild URL: ${buildLinkHTML}`;

      const canUseCustomBaseBranch =
        await this.billingService.getBooleanEntitlement(
          project.workspaceId,
          BillingFeature.ChangeGitBaseBranch
        );

      const gitProviderArgs =
        await this.gitProviderService.getGitProviderProperties(gitOrganization);
      gitSettings = {
        gitOrganizationName: gitOrganization.name,
        gitRepositoryName: resourceRepository.name,
        baseBranchName: canUseCustomBaseBranch
          ? resourceRepository.baseBranchName
          : "",
        repositoryGroupName: resourceRepository.groupName,
        gitProvider: gitProviderArgs.provider,
        gitProviderProperties: gitProviderArgs.providerOrganizationProperties,
        commit: {
          title: commitTitle,
          body: commitBody,
        },
      };
    }

    return this.actionService.run(
      build.actionId,
      PUSH_TO_GIT_STEP_NAME,
      PUSH_TO_GIT_STEP_MESSAGE(EnumGitProvider[gitSettings.gitProvider]),
      async (step) => {
        try {
          await this.actionService.logInfo(step, PUSH_TO_GIT_STEP_START_LOG);

          const smartGitSyncEntitlement = this.billingService.isBillingEnabled
            ? await this.billingService.getBooleanEntitlement(
                project.workspaceId,
                BillingFeature.SmartGitSync
              )
            : false;

          const branchPerResourceEntitlement =
            await this.billingService.getBooleanEntitlement(
              project.workspaceId,
              BillingFeature.BranchPerResource
            );

          const createPullRequestMessage: CreatePrRequest.Value = {
            ...gitSettings,
            resourceId: resource.id,
            resourceName: kebabCase(resource.name),
            newBuildId: build.id,
            oldBuildId: oldBuild?.id,
            gitResourceMeta: {
              adminUIPath: resourceInfo.settings.adminUISettings.adminUIPath,
              serverPath: resourceInfo.settings.serverSettings.serverPath,
            },
            pullRequestMode:
              smartGitSyncEntitlement && smartGitSyncEntitlement.hasAccess
                ? EnumPullRequestMode.Accumulative
                : EnumPullRequestMode.Basic,
            isBranchPerResource:
              (branchPerResourceEntitlement &&
                branchPerResourceEntitlement.hasAccess) ??
              false,
            overrideCustomizableFilesInGit:
              projectConfigurationSettings.overrideCustomizableFilesInGit ??
              false,
          };

          const createPullRequestEvent: CreatePrRequest.KafkaEvent = {
            key: {
              resourceRepositoryId: kafkaEventKey,
              /**
                  If the branch is not per resource, we want to create a PR for the entire project
                  so we set the resourceId to null to indicate avoid
                  git force action issues due to creating PR for specific resources in parallel
                  */
              resourceId: createPullRequestMessage.isBranchPerResource
                ? resource.id
                : null,
            },
            value: createPullRequestMessage,
          };
          await this.kafkaProducerService.emitMessage(
            KAFKA_TOPICS.CREATE_PR_REQUEST_TOPIC,
            createPullRequestEvent
          );
        } catch (error) {
          logger.error("Failed to emit Create Pull Request Message.", error);
        }
      },
      true
    );
  }

  /**
   *
   * @info this function must always return the entities in the same order to prevent unintended code changes
   * @returns all the entities for build order by date of creation
   */
  private async getOrderedEntities(
    buildId: string
  ): Promise<CodeGenTypes.Entity[]> {
    const entities = await this.entityService.getEntitiesByVersions({
      where: {
        builds: {
          some: {
            id: buildId,
          },
        },
      },
      include: ENTITIES_INCLUDE,
    });
    return orderBy(
      entities.map((entity) => {
        return {
          ...entity,
          fields: orderBy(entity.fields, (field) => field.name),
        };
      }),
      (entity) => entity.createdAt
    ) as unknown as CodeGenTypes.Entity[];
  }

  async canUserAccess({
    userId,
    buildId,
  }: CanUserAccessBuild.Value): Promise<boolean> {
    const build = this.prisma.build.findFirst({
      // eslint-disable-next-line @typescript-eslint/naming-convention
      where: { id: buildId, AND: { userId } },
    });
    return Boolean(build);
  }

  async getDSGResourceData(
    resourceId: string,
    buildId: string,
    buildVersion: string,
    user: User,
    rootGeneration = true
  ): Promise<CodeGenTypes.DSGResourceData> {
    const resources = await this.resourceService.resources({
      where: {
        project: { resources: { some: { id: resourceId } } },
      },
    });

    const resource = resources.find(({ id }) => id === resourceId);

    const allPlugins = await this.pluginInstallationService.findMany({
      where: { resource: { id: resourceId } },
    });

    const packages = await this.packageService.findMany({
      where: { resource: { id: resourceId } },
    });
    const plugins = allPlugins.filter((plugin) => plugin.enabled);
    const url = `${this.host}/${resourceId}`;

    const orderedPlugins =
      await this.pluginInstallationService.orderInstalledPlugins(
        resourceId,
        plugins
      );

    const moduleActions = await this.moduleActionService.findMany({
      where: { resource: { id: resourceId } },
    });

    const moduleDtos = await this.moduleDtoService.findMany({
      where: { resource: { id: resourceId } },
    });

    const modules = await this.moduleService.findMany({
      where: { resource: { id: resourceId } },
    });

    const serviceSettings =
      resource.resourceType === EnumResourceType.Service
        ? await this.serviceSettingsService.getServiceSettingsValues(
            {
              where: { id: resourceId },
            },
            user
          )
        : undefined;

    const otherResources = rootGeneration
      ? await Promise.all(
          resources
            .filter(({ id }) => id !== resourceId)
            .filter(
              ({ resourceType }) =>
                resourceType !== EnumResourceType.ProjectConfiguration &&
                resourceType !== EnumResourceType.PluginRepository
            )
            .map((resource) =>
              this.getDSGResourceData(
                resource.id,
                buildId,
                buildVersion,
                user,
                false
              )
            )
        )
      : undefined;

    const dsgResourceData = {
      entities: rootGeneration ? await this.getOrderedEntities(buildId) : [],
      roles: await this.getResourceRoles(resourceId),
      pluginInstallations: orderedPlugins,
      packages,
      moduleContainers: modules,
      moduleActions: moduleActions,
      moduleDtos: moduleDtos,
      resourceType: resource.resourceType,
      topics: await this.topicService.findMany({
        where: { resource: { id: resourceId } },
      }),
      serviceTopics: await this.serviceTopicsService.findMany({
        where: { resource: { id: resourceId } },
      }),
      buildId: buildId,
      resourceInfo: {
        name: resource.name,
        description: resource.description,
        version: buildVersion,
        id: resourceId,
        url,
        settings: serviceSettings,
        codeGeneratorVersionOptions: {
          codeGeneratorVersion: resource.codeGeneratorVersion,
          codeGeneratorStrategy:
            // resource.codeGeneratorStrategy is the value and not the key, but as the key is the same as the value we can use it
            CodeGeneratorVersionStrategy[resource.codeGeneratorStrategy],
        },
        codeGeneratorName: resource.codeGeneratorName,
      },
      otherResources,
    };

    return omitDeep(dsgResourceData, DSG_RESOURCE_DATA_PROPERTIES_TO_REMOVE);
  }

  public async onCreatePullRequestLog(
    logEntry: CreatePrLog.Value
  ): Promise<void> {
    const { buildId, level, message } = logEntry;
    const [step] = await this.prisma.build
      .findUnique({
        where: {
          id: buildId,
        },
      })
      .action()
      .steps({
        where: {
          name: PUSH_TO_GIT_STEP_NAME,
        },
      });

    await this.actionService.logByStepId(
      step.id,
      ACTION_LOG_LEVEL[level],
      message
    );
  }
}
