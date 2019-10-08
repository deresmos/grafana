// Types
import DatasourceSrv from '../plugins/datasource_srv';
import { BackendSrv } from 'app/core/services/backend_srv';
import { ContextSrv } from 'app/core/services/context_srv';

export default class AnnotationInflux {
  builtInDatasource: string;

  /** @ngInject */
  constructor(
    public $rootScope: any,
    public datasourceSrv: DatasourceSrv,
    public backendSrv: BackendSrv,
    public $http: any,
    public contextSrv: ContextSrv
  ) {}

  insertInfluxDB(annotation: any) {
    return this.datasourceSrv.get(this.builtInDatasource).then((ds: any) => {
      if (!this.checkPermission(annotation)) {
        return;
      }

      const payload = this.createInsertPayload(annotation);
      const config = {
        url: ds.urls[0] + '/write?db=' + ds.database,
        method: 'POST',
        data: payload,
      };

      return this.$http(config).then(
        (rsp: any) => {
          this.$rootScope.appEvent('alert-success', ['Update annotation to InfluxDB']);
        },
        (err: any) => {
          this.$rootScope.appEvent('alert-warning', ['Failed write annotation to InfluxDB']);
          console.log(err);
        }
      );
    });
  }

  createInsertPayload(annotation: any, create = true) {
    const id = create === true ? new Date().getTime() : annotation.id;

    let payload = 'events,id=' + id + ' ';
    const user: any = this.contextSrv.user;
    payload += 'userId=' + user.id + ',';
    payload += 'login="' + user.login + '",';
    payload += 'avatarUrl="' + user.gravatarUrl + '",';
    payload += 'email="' + user.email + '",';

    payload += 'panelId=' + annotation.panelId + ',';
    payload += 'dashboardId=' + annotation.dashboardId + ',';
    // payload += 'isRegion=' + annotation.isRegion + ',';
    payload += 'tags="' + annotation.tags.join(',') + '",';
    payload += 'text="' + annotation.text + '" ';

    payload += annotation.time + '000000';

    return payload;
  }

  updateInfluxDB(annotation: any) {
    return this.datasourceSrv.get(this.builtInDatasource).then((ds: any) => {
      if (!this.checkPermission(annotation)) {
        return;
      }

      const payload: any = {
        db: ds.database,
        q: 'DELETE FROM events WHERE "id" = \'' + annotation.id + "'",
      };

      const config = {
        url: ds.urls[0] + '/query',
        method: 'GET',
        params: payload,
      };

      return this.$http(config).then(
        (rsp: any) => {
          return this.insertInfluxDB(annotation);
        },
        (err: any) => {
          this.$rootScope.appEvent('alert-warning', ['Failed update annotation to InfluxDB']);
          console.log(err);
        }
      );
    });
  }

  deleteInfluxDB(annotation: any) {
    return this.datasourceSrv.get(this.builtInDatasource).then((ds: any) => {
      const payload: any = {
        db: ds.database,
        q: 'DELETE FROM events WHERE "id" = \'' + annotation.id + "'",
      };

      const config = {
        url: ds.urls[0] + '/query',
        method: 'GET',
        params: payload,
      };
      this.requestInflux(config);
    });
  }

  requestInflux(config: any) {
    return this.$http(config).then(
      (rsp: any) => {
        console.log(rsp);
      },
      (err: any) => {
        console.log('ERROR', err);
      }
    );
  }

  checkPermission(annotation: any) {
    if (annotation.userId === undefined) {
      return true;
    }

    const user: any = this.contextSrv.user;
    if (annotation.userId !== user.id && !user.isGrafanaAdmin) {
      this.$rootScope.appEvent('alert-warning', ['Edit permission denied']);
      return false;
    }

    return true;
  }
}
