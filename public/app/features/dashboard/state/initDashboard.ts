// Libraries
import { ThunkDispatch } from 'redux-thunk';

// Services & Utils
import { createErrorNotification } from 'app/core/copy/appNotification';
import { getBackendSrv } from 'app/core/services/backend_srv';
import { DashboardSrv } from 'app/features/dashboard/services/DashboardSrv';
import { TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { AnnotationsSrv } from 'app/features/annotations/annotations_srv';
import { VariableSrv } from 'app/features/templating/variable_srv';
import { KeybindingSrv } from 'app/core/services/keybindingSrv';
import { config } from 'app/core/config';

// Actions
import { updateLocation } from 'app/core/actions';
import { notifyApp } from 'app/core/actions';
import locationUtil from 'app/core/utils/location_util';
import { setDashboardLoadingState, ThunkResult, setDashboardModel, setDashboardLoadingSlow } from './actions';

// Types
import { DashboardLoadingState, DashboardRouteInfo, StoreState } from 'app/types';
import { DashboardModel } from './DashboardModel';

export type Dispatch = ThunkDispatch<StoreState, undefined, any>;

export interface InitDashboardArgs {
  $injector: any;
  $scope: any;
  urlUid?: string;
  urlSlug?: string;
  urlType?: string;
  urlFolderId?: string;
  routeInfo: DashboardRouteInfo;
  fixUrl: boolean;
}

async function redirectToNewUrl(slug: string, dispatch: Dispatch, currentPath: string) {
  const res = await getBackendSrv().getDashboardBySlug(slug);

  if (res) {
    let newUrl = res.meta.url;

    // fix solo route urls
    if (currentPath.indexOf('dashboard-solo') !== -1) {
      newUrl = newUrl.replace('/d/', '/d-solo/');
    }

    const url = locationUtil.stripBaseFromUrl(newUrl);
    dispatch(updateLocation({ path: url, partial: true, replace: true }));
  }
}

async function fetchDashboard(args: InitDashboardArgs, dispatch: Dispatch, getState: () => StoreState): Promise<any> {
  try {
    switch (args.routeInfo) {
      case DashboardRouteInfo.Home: {
        // load home dash
        const dashDTO = await getBackendSrv().get('/api/dashboards/home');

        // if user specified a custom home dashboard redirect to that
        if (dashDTO.redirectUri) {
          const newUrl = locationUtil.stripBaseFromUrl(dashDTO.redirectUri);
          dispatch(updateLocation({ path: newUrl, replace: true }));
          return;
        }

        // disable some actions on the default home dashboard
        dashDTO.meta.canSave = false;
        dashDTO.meta.canShare = false;
        dashDTO.meta.canStar = false;
        return dashDTO;
      }
      case DashboardRouteInfo.Normal: {
        // for old db routes we redirect
        if (args.urlType === 'db') {
          redirectToNewUrl(args.urlSlug, dispatch, getState().location.path);
          return null;
        }

        const loaderSrv = args.$injector.get('dashboardLoaderSrv');
        const dashDTO = await loaderSrv.loadDashboard(args.urlType, args.urlSlug, args.urlUid);

        if (args.fixUrl && dashDTO.meta.url) {
          // check if the current url is correct (might be old slug)
          const dashboardUrl = locationUtil.stripBaseFromUrl(dashDTO.meta.url);
          const currentPath = getState().location.path;

          if (dashboardUrl !== currentPath) {
            // replace url to not create additional history items and then return so that initDashboard below isn't executed multiple times.
            dispatch(updateLocation({ path: dashboardUrl, partial: true, replace: true }));
            return null;
          }
        }
        return dashDTO;
      }
      case DashboardRouteInfo.New: {
        return getNewDashboardModelData(args.urlFolderId);
      }
    }
  } catch (err) {
    dispatch(setDashboardLoadingState(DashboardLoadingState.Error));
    dispatch(notifyApp(createErrorNotification('Dashboard fetch failed', err)));
    console.log(err);
    return null;
  }
}

/**
 * This action (or saga) does everything needed to bootstrap a dashboard & dashboard model.
 * First it handles the process of fetching the dashboard, correcting the url if required (causing redirects/url updates)
 *
 * This is used both for single dashboard & solo panel routes, home & new dashboard routes.
 *
 * Then it handles the initializing of the old angular services that the dashboard components & panels still depend on
 *
 */
export function initDashboard(args: InitDashboardArgs): ThunkResult<void> {
  return async (dispatch, getState) => {
    // set fetching state
    dispatch(setDashboardLoadingState(DashboardLoadingState.Fetching));

    // Detect slow loading / initializing and set state flag
    // This is in order to not show loading indication for fast loading dashboards as it creates blinking/flashing
    setTimeout(() => {
      if (getState().dashboard.model === null) {
        dispatch(setDashboardLoadingSlow());
      }
    }, 500);

    // fetch dashboard data
    const dashDTO = await fetchDashboard(args, dispatch, getState);

    // returns null if there was a redirect or error
    if (!dashDTO) {
      return;
    }

    // set initializing state
    dispatch(setDashboardLoadingState(DashboardLoadingState.Initializing));

    // create model
    let dashboard: DashboardModel;
    try {
      dashboard = new DashboardModel(dashDTO.dashboard, dashDTO.meta);
    } catch (err) {
      dispatch(setDashboardLoadingState(DashboardLoadingState.Error));
      dispatch(notifyApp(createErrorNotification('Dashboard model initializing failure', err)));
      console.log(err);
      return;
    }

    // add missing orgId query param
    if (!getState().location.query.orgId) {
      dispatch(updateLocation({ query: { orgId: config.bootData.user.orgId }, partial: true, replace: true }));
    }

    // init services
    const timeSrv: TimeSrv = args.$injector.get('timeSrv');
    const annotationsSrv: AnnotationsSrv = args.$injector.get('annotationsSrv');
    const variableSrv: VariableSrv = args.$injector.get('variableSrv');
    const keybindingSrv: KeybindingSrv = args.$injector.get('keybindingSrv');
    const unsavedChangesSrv = args.$injector.get('unsavedChangesSrv');
    const dashboardSrv: DashboardSrv = args.$injector.get('dashboardSrv');

    timeSrv.init(dashboard);
    annotationsSrv.init(dashboard);

    // template values service needs to initialize completely before
    // the rest of the dashboard can load
    try {
      await variableSrv.init(dashboard);
    } catch (err) {
      dispatch(notifyApp(createErrorNotification('Templating init failed', err)));
      console.log(err);
    }

    try {
      dashboard.processRepeats();
      dashboard.updateSubmenuVisibility();

      // handle auto fix experimental feature
      const queryParams = getState().location.query;
      if (queryParams.autofitpanels) {
        dashboard.autoFitPanels(window.innerHeight, queryParams.kiosk);
      }

      // init unsaved changes tracking
      unsavedChangesSrv.init(dashboard, args.$scope);
      keybindingSrv.setupDashboardBindings(args.$scope, dashboard);
    } catch (err) {
      dispatch(notifyApp(createErrorNotification('Dashboard init failed', err)));
      console.log(err);
    }

    // legacy srv state
    dashboardSrv.setCurrent(dashboard);
    // set model in redux (even though it's mutable)
    dispatch(setDashboardModel(dashboard));
  };
}

function getNewDashboardModelData(urlFolderId?: string): any {
  const data = {
    meta: {
      canStar: false,
      canShare: false,
      isNew: true,
      folderId: 0,
    },
    dashboard: {
      title: 'New dashboard',
      panels: [
        {
          type: 'add-panel',
          gridPos: { x: 0, y: 0, w: 12, h: 9 },
          title: 'Panel Title',
        },
      ],
    },
  };

  if (urlFolderId) {
    data.meta.folderId = parseInt(urlFolderId, 10);
  }

  return data;
}
