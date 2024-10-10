import { Icon } from "@amplication/ui/design-system";
import { Collapse, ListItem, ListItemText } from "@mui/material";
import React, {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useHistory, useLocation } from "react-router-dom";
import { AppContext } from "../context/appContext";
import InnerTabLink from "../Layout/InnerTabLink";
import { useResourceBaseUrl } from "../util/useResourceBaseUrl";
import usePlugins from "./hooks/usePlugins";
import "./PluginTree.scss";

const CLASS_NAME = "plugin-tree";

export const PRIVATE_PLUGINS_CATEGORY = "private-plugins";

type Props = {
  resourceId: string;
  selectFirst?: boolean;
};

export const PluginTree = React.memo(
  ({ resourceId, selectFirst = false }: Props) => {
    const location = useLocation();
    const [chevronIcon, setChevronIcon] = useState("open");
    const history = useHistory();
    const { currentResource } = useContext(AppContext);

    const { baseUrl } = useResourceBaseUrl({ overrideResourceId: resourceId });

    const { categories } = usePlugins(
      currentResource.id,
      null,
      currentResource?.codeGenerator
    );

    useLayoutEffect(() => {
      const urlArr = location.pathname.split("/");
      if (urlArr[urlArr.length - 1] !== "plugins") return;

      history.push(`${location.pathname}/catalog`);
    }, [location]);

    const handleCategoriesClick = useCallback(() => {
      setChevronIcon(chevronIcon === "close" ? "open" : "close");
    }, [chevronIcon]);

    const setCategoriesLinks = useMemo(() => {
      return categories.map((category) => (
        <InnerTabLink
          key={category}
          icon="plugins"
          to={`${baseUrl}/plugins/catalog/${encodeURIComponent(category)}`}
        >
          <span>{category}</span>
        </InnerTabLink>
      ));
    }, [categories, baseUrl]);

    return (
      <div className={CLASS_NAME}>
        <div className={`${CLASS_NAME}__list`}>
          <InnerTabLink
            key={"catalog"}
            icon="plugins"
            to={`${baseUrl}/plugins/catalog`}
          >
            <span>All Plugins</span>
          </InnerTabLink>
          <InnerTabLink
            icon="plugins"
            to={`${baseUrl}/plugins/catalog/${PRIVATE_PLUGINS_CATEGORY}`}
          >
            <span>Private Plugins</span>
          </InnerTabLink>
          <InnerTabLink icon="plugins" to={`${baseUrl}/plugins/installed`}>
            <span>Installed Plugins</span>
          </InnerTabLink>
          <ListItem
            onClick={handleCategoriesClick}
            className={`${CLASS_NAME}__categories_container`}
          >
            <ListItemText>
              <Icon icon={"filter"} />
              <div className={`${CLASS_NAME}__categories_title`}>
                Categories
              </div>
              <Icon
                className={`${CLASS_NAME}__categories_chevron`}
                icon={chevronIcon === "open" ? "chevron_down" : "chevron_up"}
                size="small"
              />
            </ListItemText>
          </ListItem>
          <Collapse in={chevronIcon === "open"} timeout="auto" unmountOnExit>
            {setCategoriesLinks}
          </Collapse>
        </div>
      </div>
    );
  }
);
